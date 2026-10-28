// SPDX-License-Identifier: GPL-3.0-or-later
// The facts About This PC shows, read asynchronously every time the dialog opens
// (as macOS About This Mac and System Information). Nothing here blocks the compositor.
//
//   const info = await readSystemInfo(cancellable);
//   // {name, model, chassis, os, cpu, memory, gpus, disk: {size, free}, gnome}
//
// Sources: org.freedesktop.hostname1 (names, vendor, model, chassis), /etc/os-release,
// /proc/cpuinfo, /proc/meminfo, net.hadess.SwitcherooControl (GPUs), the root file system's
// size, Config.PACKAGE_VERSION. Every source is optional: a missing one leaves its field null.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import { deviceModel, gpuNames, parseCpuInfo, parseMemTotal, parseOsRelease } from './model.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');

const decoder = new TextDecoder();

/** A small text file, read asynchronously; null when it cannot be read. */
export async function readText(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch (_e) {
        return null;
    }
}

async function properties(bus, name, path, iface, keys, cancellable) {
    try {
        const proxy = await Gio.DBusProxy.new_for_bus(bus, Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
            null, name, path, iface, cancellable);
        const out = {};
        for (const k of keys)
            out[k] = proxy.get_cached_property(k)?.recursiveUnpack() ?? null;
        return out;
    } catch (_e) {
        return {};
    }
}

/**
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<object>}
 */
export async function readSystemInfo(cancellable) {
    const [host, osText, cpuText, memText, gpu, fs] = await Promise.all([
        properties(Gio.BusType.SYSTEM, 'org.freedesktop.hostname1', '/org/freedesktop/hostname1',
            'org.freedesktop.hostname1',
            ['PrettyHostname', 'Hostname', 'HardwareVendor', 'HardwareModel', 'Chassis'], cancellable),
        readText('/etc/os-release', cancellable).then(t => t ?? readText('/usr/lib/os-release', cancellable)),
        readText('/proc/cpuinfo', cancellable),
        readText('/proc/meminfo', cancellable),
        properties(Gio.BusType.SYSTEM, 'net.hadess.SwitcherooControl', '/net/hadess/SwitcherooControl',
            'net.hadess.SwitcherooControl', ['GPUs'], cancellable),
        Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::size,filesystem::free',
            GLib.PRIORITY_DEFAULT, cancellable).catch(() => null),
    ]);
    const os = parseOsRelease(osText);
    const cpu = parseCpuInfo(cpuText);
    return {
        name: host.PrettyHostname || host.Hostname || GLib.get_host_name(),
        model: deviceModel(host.HardwareVendor, host.HardwareModel),
        chassis: host.Chassis || null,
        os: {
            name: os.PRETTY_NAME || [os.NAME, os.VERSION].filter(Boolean).join(' ') || null,
            logo: os.LOGO || null,
        },
        cpu: cpu.model ? (cpu.threads > 1 ? `${cpu.model} × ${cpu.threads}` : cpu.model) : null,
        memory: parseMemTotal(memText),
        gpus: gpuNames(gpu.GPUs ?? []),
        disk: fs ? {
            size: Number(fs.get_attribute_uint64('filesystem::size')),
            free: Number(fs.get_attribute_uint64('filesystem::free')),
        } : null,
        gnome: Config.PACKAGE_VERSION,
    };
}
