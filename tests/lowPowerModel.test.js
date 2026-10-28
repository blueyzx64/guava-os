// Run: gjs -m tests/lowPowerModel.test.js
import { batteryHealth, holdAction, lowPowerToggle, lowPowerWanted } from '../features/lowPower/model.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok   ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL ${name}: ${e.message}`);
    }
}
function eq(a, b) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

test('each power source has its own choice', () => {
    eq(lowPowerWanted({ onBattery: true, battery: true, adapter: false }), true);
    eq(lowPowerWanted({ onBattery: false, battery: true, adapter: false }), false);
    eq(lowPowerWanted({ onBattery: false, battery: false, adapter: true }), true);
    eq(lowPowerWanted({ onBattery: true, battery: false, adapter: true }), false);
    eq(lowPowerWanted({ onBattery: true, battery: true, adapter: false, hasBattery: false }), false);
});

test('the Control Center switch flips the choice of the source in use', () => {
    eq(lowPowerToggle({ onBattery: true, battery: false, adapter: true }), { key: 'low-power-battery', value: true });
    eq(lowPowerToggle({ onBattery: false, battery: true, adapter: true }), { key: 'low-power-adapter', value: false });
    eq(lowPowerToggle({ onBattery: true, hasBattery: false, battery: false, adapter: false }), { key: 'low-power-adapter', value: true });
});

test('holdAction', () => {
    eq([holdAction(true, false), holdAction(false, true), holdAction(true, true), holdAction(false, false)],
        ['hold', 'release', null, null]);
});

test('battery health from Capacity or energy, with cycles', () => {
    eq(batteryHealth({ capacity: 91.6, cycles: 312 }), { percent: 92, cycles: 312, condition: 'normal' });
    eq(batteryHealth({ energyFull: 38, energyFullDesign: 50 }), { percent: 76, cycles: null, condition: 'service' });
    eq(batteryHealth({}), null);
    eq(batteryHealth({ capacity: 104 }).percent, 100);
});

if (failed)
    throw new Error(`${failed} test(s) failed`);
