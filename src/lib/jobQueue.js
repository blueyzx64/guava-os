// SPDX-License-Identifier: GPL-3.0-or-later
// A promise queue: jobs run one after another; a failing job is reported and does not stop
// the next. Share one queue between all writers of the same files. Pure JS.

/**
 * @param {(error: Error) => void} [onError]
 * @returns {(job: () => Promise<*>|*) => Promise<*>} enqueue
 */
export function createJobQueue(onError = () => {}) {
    let tail = Promise.resolve();
    return job => {
        tail = tail.then(job).catch(onError);
        return tail;
    };
}
