// Run: gjs -m tests/spotlightCalculator.test.js
import {
    calculate, convert, convertUnits, evaluateQuery, formatNumber, MAX_INPUT_LENGTH,
} from '../features/spotlight/calculator.js';

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
const val = s => calculate(s)?.value;
const near = (a, b) => {
    if (!(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b))))
        throw new Error(`expected ~${b}, got ${a}`);
};

// --- arithmetic
test('add', () => eq(val('1+2'), 3));
test('precedence', () => eq(val('2+3*4'), 14));
test('parens', () => eq(val('(2+3)*4'), 20));
test('power right assoc', () => eq(val('2^3^2'), 512));
test('double star is power', () => eq(val('2**10'), 1024));
test('unary minus binds below power', () => eq(val('-2^2'), -4));
test('unary chain', () => eq(val('--3+1'), 4));
test('typographic operators', () => eq(val('6 × 7 ÷ 2 − 1'), 20));
test('decimals', () => near(val('0.1+0.2'), 0.3));
test('leading dot', () => eq(val('.5*4'), 2));
test('exponent literal', () => eq(val('1e3+1'), 1001));
test('percent postfix', () => eq(val('50%'), 0.5));
test('percent of', () => eq(val('200*10%'), 20));
test('modulo', () => eq(val('10 % 3'), 1));
test('functions', () => eq(val('sqrt(16)+abs(-2)'), 6));
test('constants', () => near(val('2*pi'), 2 * Math.PI));
test('pi symbol', () => near(val('2*π'), 2 * Math.PI));
test('implicit multiply', () => eq(val('2(3+4)'), 14));
test('implicit product alone is not math', () => eq(calculate('2pi'), null));
test('trig', () => near(val('sin(0)+cos(0)'), 1));
test('log', () => eq(val('log(1000)'), 3));
test('spaces', () => eq(val('  1 +   1  '), 2));

// --- not a calculation
test('plain number is not a calc', () => eq(calculate('42'), null));
test('signed number is not a calc', () => eq(calculate('-42'), null));
test('plain words', () => eq(calculate('firefox'), null));
test('empty', () => eq(calculate(''), null));
test('only operator', () => eq(calculate('+'), null));
test('dangling operator', () => eq(calculate('1+'), null));
test('two numbers', () => eq(calculate('2 3'), null));
test('unbalanced open', () => eq(calculate('(1+2'), null));
test('unbalanced close', () => eq(calculate('1+2)'), null));
test('divide by zero', () => eq(calculate('1/0'), null));
test('modulo by zero', () => eq(calculate('1%0'), null));
test('sqrt of negative is NaN, rejected', () => eq(calculate('sqrt(-1)'), null));
test('overflow rejected', () => eq(calculate('10^400'), null));
test('huge power chain rejected', () => eq(calculate('9^9^9^9'), null));

// --- malicious input: nothing is ever executed
test('no eval: process.exit', () => eq(calculate('process.exit()'), null));
test('no eval: constructor chain', () => eq(calculate('constructor.constructor("return 1")()'), null));
test('no eval: __proto__', () => eq(calculate('__proto__'), null));
test('no eval: toString name', () => eq(calculate('toString(1)'), null));
test('no eval: hasOwnProperty name', () => eq(calculate('hasOwnProperty+1'), null));
test('no eval: constructor name', () => eq(calculate('constructor*2'), null));
test('no eval: template string', () => eq(calculate('`${1+1}`'), null));
test('no eval: import call', () => eq(calculate('import("x")'), null));
test('no eval: assignment', () => eq(calculate('a=1+1'), null));
test('no eval: semicolon', () => eq(calculate('1+1;2+2'), null));
test('no eval: global lookup', () => eq(calculate('globalThis+1'), null));
test('no eval: unicode lookalike', () => eq(calculate('１+１'), null));
test('no eval: null byte', () => eq(calculate('1+\u00001'), null));
test('deep parens do not overflow the stack', () =>
    eq(calculate('('.repeat(150) + '1+1' + ')'.repeat(150)), null));
test('deep unary chain', () => eq(calculate('-'.repeat(190) + '1+1'), null));
test('long input rejected', () => eq(calculate('1+'.repeat(MAX_INPUT_LENGTH)), null));
test('many tokens rejected', () => eq(calculate('1+1+1+'.repeat(30) + '1'), null));
test('non-string', () => eq(calculate({ toString() { return '1+1'; } }), null));
test('undefined', () => eq(calculate(undefined), null));
test('object prototype keys as function names', () => {
    for (const name of ['valueOf', 'constructor', 'toString', '__proto__', '__defineGetter__'])
        eq(calculate(`${name}(2)`), null);
});

// --- V5: non-finite and ambiguous queries
test('1e999% gives no result', () => eq(calculate('1e999%'), null));
test('-1e999% gives no result', () => eq(calculate('-1e999%'), null));
test('1e999 literal rejected', () => eq(calculate('1e999+1'), null));
test('result is never non-finite', () => {
    for (const q of ['1e308*10', '1e308+1e308', '-1e308*10', '1e999%', '10^309'])
        eq(calculate(q), null);
});
test('bare constants are not math', () => {
    for (const q of ['e', 'pi', 'tau', 'E', 'PI', 'pi e'])
        eq(calculate(q), null);
});
test('times are not math', () => {
    eq(calculate('10:30'), null);
    eq(calculate('9:05:30'), null);
});
test('dates are not math', () => {
    eq(calculate('2024-10-25'), null);
    eq(calculate('2024-1-5'), null);
});
test('colon is not division', () => eq(calculate('10:2'), null));
test('constants with an operator and a digit still work', () => near(val('pi*2'), 2 * Math.PI));
test('function call counts as math', () => eq(val('sqrt(16)'), 4));
test('evaluateQuery: no calc for a plain word, date or constant', () => {
    for (const q of ['e', 'pi', '2024-10-25', '10:30', 'firefox'])
        eq(evaluateQuery(q), null);
});

// --- formatting
test('format trims float noise', () => eq(formatNumber(0.1 + 0.2), '0.3'));
test('format large', () => eq(formatNumber(1e20), '1e20'));
test('format small', () => eq(formatNumber(1.5e-9), '1.5e-9'));
test('format integer', () => eq(formatNumber(1234567), '1234567'));
test('format negative zero', () => eq(calculate('0*-1').text, '0'));

// --- units
test('km to miles', () => eq(convert('5 km in miles').text, '3.10685596119 mi'));
test('tight spelling', () => eq(convert('5km to mi').text, '3.10685596119 mi'));
test('miles to km', () => near(convert('10 miles to km').value, 16.09344));
test('expression amount', () => near(convert('2*3 ft in inches').value, 72));
test('f to c', () => near(convert('212 f to c').value, 100));
test('c to f', () => near(convert('-40 c in f').value, -40));
test('c to k', () => near(convert('0 celsius to kelvin').value, 273.15));
test('kg to lb', () => near(convert('1 kg to lb').value, 2.2046226218));
test('hours to minutes', () => near(convert('2.5 hours in minutes').value, 150));
test('gib to mib', () => near(convert('1 gib to mib').value, 1024));
test('inch is a unit but "in" the keyword still works', () => near(convert('10 in to cm').value, 25.4));
test('mismatched dimension', () => eq(convert('5 km in kg'), null));
test('unknown unit', () => eq(convert('5 parsec in km'), null));
test('not a conversion', () => eq(convert('firefox in km'), null));
test('convertUnits null on garbage', () => eq(convertUnits(NaN, 'km', 'mi'), null));
test('convertUnits overflow', () => eq(convertUnits(1e300, 'km', 'mm'), null));
test('prototype key as unit', () => eq(convert('5 constructor to km'), null));
test('conversion text label', () => eq(convert('1 l to ml').text, '1000 mL'));

// --- evaluateQuery
test('query: unit wins', () => eq(evaluateQuery('1 km in m').kind, 'unit'));
test('query: math', () => eq(evaluateQuery('1+1'), { kind: 'math', value: 2, text: '2', expression: '1+1' }));
test('query: nothing', () => eq(evaluateQuery('hello'), null));
test('query: null', () => eq(evaluateQuery(null), null));

if (failed > 0)
    throw new Error(`${failed} test(s) failed`);
print('calculator: all passed');
