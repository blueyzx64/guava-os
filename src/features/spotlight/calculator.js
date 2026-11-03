// SPDX-License-Identifier: GPL-3.0-or-later
// Spotlight calculator: arithmetic and unit conversion. Pure (no gi imports), and it never
// uses eval, Function or any dynamic code. Input is tokenised, parsed by a recursive-descent
// parser into a small tree and evaluated by walking it. Every stage has a hard size limit,
// so hostile input ends in `null`, not in a hang or a throw.

export const MAX_INPUT_LENGTH = 200;
const MAX_TOKENS = 120;
const MAX_DEPTH = 32;
const MAX_ABS = 1e300;

const FUNCTIONS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor,
    ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, log10: Math.log10,
    log2: Math.log2, exp: Math.exp,
};
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

class CalcError extends Error {}

function fail(msg) {
    throw new CalcError(msg);
}

/** Replace typographic operators and strip spaces, so "2 × 3" and "2*3" are the same. */
function normalise(text) {
    return text
        .replace(/[×·]/g, '*')
        .replace(/÷/g, '/')
        .replace(/[−–—]/g, '-')
        .replace(/\*\*/g, '^')
        .replace(/π/g, 'pi')
        .replace(/√/g, 'sqrt');
}

function tokenize(text) {
    const src = normalise(text);
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t') {
            i++;
        } else if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
            // "2e" or "2e+" is the number 2 followed by the constant e; the regex above only
            // takes an exponent that has digits.
            tokens.push({ t: 'num', v: Number(m[0]) });
            i += m[0].length;
        } else if (/[a-z]/i.test(c)) {
            const m = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
            tokens.push({ t: 'id', v: m[0].toLowerCase() });
            i += m[0].length;
        } else if ('+-*/^%(),'.includes(c)) {
            tokens.push({ t: c });
            i++;
        } else {
            fail(`bad character ${c}`);
        }
        if (tokens.length > MAX_TOKENS)
            fail('too long');
    }
    return tokens;
}

// Grammar:
//   expr   := term (('+'|'-') term)*
//   term   := unary (('*'|'/'|'%'-as-modulo) unary | implicit-multiply)*
//   unary  := ('-'|'+') unary | power
//   power  := postfix ('^' unary)?          right associative; -2^2 = -(2^2)
//   postfix:= primary '%'?                   percent when no operand follows
//   primary:= num | const | func '(' args ')' | '(' expr ')'
class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
        this.depth = 0;
    }

    peek(k = 0) {
        return this.tokens[this.pos + k];
    }

    take(type) {
        const tok = this.peek();
        if (tok?.t !== type)
            fail(`expected ${type}`);
        this.pos++;
        return tok;
    }

    enter() {
        if (++this.depth > MAX_DEPTH)
            fail('too deep');
    }

    leave() {
        this.depth--;
    }

    startsOperand(tok) {
        return !!tok && (tok.t === 'num' || tok.t === '(' || tok.t === 'id');
    }

    parse() {
        const node = this.expr();
        if (this.pos !== this.tokens.length)
            fail('trailing input');
        return node;
    }

    expr() {
        this.enter();
        let left = this.term();
        for (;;) {
            const t = this.peek()?.t;
            if (t !== '+' && t !== '-')
                break;
            this.pos++;
            left = { op: t, a: left, b: this.term() };
        }
        this.leave();
        return left;
    }

    term() {
        let left = this.unary();
        for (;;) {
            const tok = this.peek();
            if (!tok)
                break;
            if (tok.t === '*' || tok.t === '/') {
                this.pos++;
                left = { op: tok.t, a: left, b: this.unary() };
            } else if (tok.t === '%' && this.startsOperand(this.peek(1))) {
                this.pos++;
                left = { op: '%', a: left, b: this.unary() };
            } else if (tok.t === '(' || (tok.t === 'num' && left.op !== 'num') ||
                       (tok.t === 'id' && (left.op === 'num' || left.op === 'pct'))) {
                // "2(3+4)", "2pi", "(1+2)3": implicit multiplication
                left = { op: '*', a: left, b: this.unary() };
            } else {
                break;
            }
        }
        return left;
    }

    unary() {
        const tok = this.peek();
        if (tok?.t === '-' || tok?.t === '+') {
            this.pos++;
            this.enter();
            const a = this.unary();
            this.leave();
            return tok.t === '-' ? { op: 'neg', a } : a;
        }
        return this.power();
    }

    power() {
        const base = this.postfix();
        if (this.peek()?.t === '^') {
            this.pos++;
            this.enter();
            const exp = this.unary();
            this.leave();
            return { op: '^', a: base, b: exp };
        }
        return base;
    }

    postfix() {
        let node = this.primary();
        if (this.peek()?.t === '%' && !this.startsOperand(this.peek(1))) {
            this.pos++;
            node = { op: 'pct', a: node };
        }
        return node;
    }

    primary() {
        const tok = this.peek();
        if (!tok)
            fail('unexpected end');
        if (tok.t === 'num') {
            this.pos++;
            return { op: 'num', v: tok.v };
        }
        if (tok.t === '(') {
            this.pos++;
            const inner = this.expr();
            this.take(')');
            return inner;
        }
        if (tok.t === 'id') {
            this.pos++;
            if (Object.hasOwn(FUNCTIONS, tok.v)) {
                this.take('(');
                const arg = this.expr();
                this.take(')');
                return { op: 'fn', name: tok.v, a: arg };
            }
            if (Object.hasOwn(CONSTANTS, tok.v))
                return { op: 'const', name: tok.v };
            fail(`unknown name ${tok.v}`);
        }
        return fail(`unexpected ${tok.t}`);
    }
}

function checked(x) {
    if (!Number.isFinite(x) || Math.abs(x) > MAX_ABS)
        fail('out of range');
    return x;
}

function evaluate(node) {
    switch (node.op) {
    case 'num': return checked(node.v);
    case 'const': return CONSTANTS[node.name];
    case 'neg': return checked(-evaluate(node.a));
    case 'pct': return checked(evaluate(node.a) / 100);
    case 'fn': return checked(FUNCTIONS[node.name](evaluate(node.a)));
    case '+': return checked(evaluate(node.a) + evaluate(node.b));
    case '-': return checked(evaluate(node.a) - evaluate(node.b));
    case '*': return checked(evaluate(node.a) * evaluate(node.b));
    case '/': {
        const d = evaluate(node.b);
        if (d === 0)
            fail('divide by zero');
        return checked(evaluate(node.a) / d);
    }
    case '%': {
        const d = evaluate(node.b);
        if (d === 0)
            fail('divide by zero');
        return checked(evaluate(node.a) % d);
    }
    case '^': return checked(Math.pow(evaluate(node.a), evaluate(node.b)));
    default: return fail('bad node');
    }
}

/** True for a bare number or a signed bare number: not worth showing as a calculation. */
function isTrivial(node) {
    return node.op === 'num' || (node.op === 'neg' && isTrivial(node.a));
}

const DATE_RE = /^\s*\d{4}-\d{1,2}-\d{1,2}\s*$/;
const TIME_RE = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/;
const OPERATOR_RE = /[+\-*/^%×÷−–—·√]|\*\*/;
const FUNCTION_CALL_RE = /[a-z]\s*\(/i;

/**
 * True only when the query is unambiguously math: at least one digit and an operator or a
 * function call. Bare constants ("e", "pi"), implicit products ("2pi"), dates and times are not.
 */
export function looksLikeMath(text) {
    if (typeof text !== 'string' || !/\d/.test(text))
        return false;
    if (DATE_RE.test(text) || TIME_RE.test(text))
        return false;
    return OPERATOR_RE.test(text) || FUNCTION_CALL_RE.test(text);
}

/**
 * Evaluate plain arithmetic.
 * @param {string} text
 * @returns {{value:number, text:string}|null} null when it is not a calculation, or fails
 */
export function calculate(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_LENGTH)
        return null;
    if (!looksLikeMath(text))
        return null;
    try {
        const tokens = tokenize(text);
        if (tokens.length === 0)
            return null;
        const tree = new Parser(tokens).parse();
        if (isTrivial(tree))
            return null;
        const value = evaluate(tree);
        if (!Number.isFinite(value))
            return null;
        if (Object.is(value, -0))
            return { value: 0, text: '0' };
        const shown = formatNumber(value);
        return shown ? { value, text: shown } : null;
    } catch (e) {
        if (e instanceof CalcError)
            return null;
        // RangeError (stack) or any unexpected bug must not reach the shell
        return null;
    }
}

/** At most 12 significant digits, no trailing zeros, exponent form when huge or tiny. */
export function formatNumber(value) {
    if (!Number.isFinite(value))
        return '';
    if (value === 0)
        return '0';
    const abs = Math.abs(value);
    if (abs >= 1e15 || abs < 1e-6)
        return Number(value.toPrecision(12)).toExponential().replace('e+', 'e');
    return String(Number(value.toPrecision(12)));
}

// ---- Units -----------------------------------------------------------------
// Each dimension maps names to a factor into the base unit. Temperature is affine.
const DIMENSIONS = {
    length: {
        m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
        km: 1000, kilometer: 1000, kilometers: 1000, kilometre: 1000, kilometres: 1000,
        cm: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01,
        mm: 0.001, millimeter: 0.001, millimeters: 0.001, millimetre: 0.001, millimetres: 0.001,
        mi: 1609.344, mile: 1609.344, miles: 1609.344,
        yd: 0.9144, yard: 0.9144, yards: 0.9144,
        ft: 0.3048, foot: 0.3048, feet: 0.3048,
        in: 0.0254, inch: 0.0254, inches: 0.0254,
        nmi: 1852,
    },
    mass: {
        g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000, mg: 0.001,
        t: 1e6, tonne: 1e6, tonnes: 1e6,
        lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
        oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
    },
    volume: {
        l: 1, liter: 1, liters: 1, litre: 1, litres: 1, ml: 0.001, milliliter: 0.001,
        milliliters: 0.001, cl: 0.01,
        gal: 3.785411784, gallon: 3.785411784, gallons: 3.785411784,
        qt: 0.946352946, quart: 0.946352946, quarts: 0.946352946,
        pt: 0.473176473, pint: 0.473176473, pints: 0.473176473,
        cup: 0.2365882365, cups: 0.2365882365,
        floz: 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375,
    },
    time: {
        s: 1, sec: 1, second: 1, seconds: 1, ms: 0.001, min: 60, minute: 60, minutes: 60,
        h: 3600, hr: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400,
        wk: 604800, week: 604800, weeks: 604800,
    },
    data: {
        byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
        kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776,
    },
    speed: {
        'm/s': 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, kph: 1 / 3.6, mph: 0.44704,
        kn: 0.514444444, knot: 0.514444444, knots: 0.514444444,
    },
    area: {
        m2: 1, sqm: 1, km2: 1e6, sqkm: 1e6, cm2: 1e-4, ha: 1e4, hectare: 1e4, hectares: 1e4,
        acre: 4046.8564224, acres: 4046.8564224, ft2: 0.09290304, sqft: 0.09290304,
        mi2: 2589988.110336, sqmi: 2589988.110336,
    },
};

const TEMPERATURE = {
    c: { toBase: v => v, fromBase: v => v },
    celsius: { toBase: v => v, fromBase: v => v },
    f: { toBase: v => (v - 32) * 5 / 9, fromBase: v => v * 9 / 5 + 32 },
    fahrenheit: { toBase: v => (v - 32) * 5 / 9, fromBase: v => v * 9 / 5 + 32 },
    k: { toBase: v => v - 273.15, fromBase: v => v + 273.15 },
    kelvin: { toBase: v => v - 273.15, fromBase: v => v + 273.15 },
};

const UNIT_LABEL = {
    meters: 'm', metres: 'm', kilometers: 'km', kilometres: 'km', centimeters: 'cm',
    centimetres: 'cm', millimeters: 'mm', millimetres: 'mm', miles: 'mi', mile: 'mi',
    yards: 'yd', yard: 'yd', feet: 'ft', foot: 'ft', inches: 'in', inch: 'in',
    grams: 'g', kilograms: 'kg', pounds: 'lb', pound: 'lb', lbs: 'lb', ounces: 'oz', ounce: 'oz',
    liters: 'L', liter: 'L', litres: 'L', litre: 'L', l: 'L', milliliters: 'mL', ml: 'mL',
    gallons: 'gal', gallon: 'gal', quarts: 'qt', quart: 'qt', pints: 'pt', pint: 'pt',
    seconds: 's', second: 's', sec: 's', minutes: 'min', minute: 'min', hours: 'h', hour: 'h',
    hr: 'h', days: 'd', day: 'd', weeks: 'wk', week: 'wk',
    byte: 'B', bytes: 'B', kb: 'kB', mb: 'MB', gb: 'GB', tb: 'TB', kib: 'KiB', mib: 'MiB',
    gib: 'GiB', tib: 'TiB', kmh: 'km/h', kph: 'km/h', knots: 'kn', knot: 'kn',
    celsius: '°C', c: '°C', fahrenheit: '°F', f: '°F', kelvin: 'K', k: 'K',
    sqm: 'm²', m2: 'm²', km2: 'km²', sqkm: 'km²', cm2: 'cm²', ft2: 'ft²', sqft: 'ft²',
    mi2: 'mi²', sqmi: 'mi²', hectares: 'ha', hectare: 'ha', acres: 'acre',
};

function labelFor(name) {
    return UNIT_LABEL[name] ?? name;
}

function findUnit(name) {
    const key = name.toLowerCase().replace(/^°/, '').replace(/^deg(?:rees?)?\s*/, '');
    if (Object.hasOwn(TEMPERATURE, key))
        return { dim: 'temperature', key, temp: TEMPERATURE[key] };
    for (const [dim, table] of Object.entries(DIMENSIONS)) {
        if (Object.hasOwn(table, key))
            return { dim, key, factor: table[key] };
    }
    return null;
}

/** Convert `value` between two unit names. Returns null when unknown or mismatched. */
export function convertUnits(value, fromName, toName) {
    const from = findUnit(fromName);
    const to = findUnit(toName);
    if (!from || !to || from.dim !== to.dim || !Number.isFinite(value))
        return null;
    let out;
    if (from.dim === 'temperature')
        out = to.temp.fromBase(from.temp.toBase(value));
    else
        out = value * from.factor / to.factor;
    return Number.isFinite(out) && Math.abs(out) <= MAX_ABS ? out : null;
}

const UNIT_RE = /^(.*[\d)%.a-z])\s+([a-z°][a-z°/0-9]*)\s+(?:in|to|as|into)\s+([a-z°][a-z°/0-9]*)$/i;
const UNIT_RE_TIGHT = /^(.*[\d)%.])\s*([a-z°][a-z°/0-9]*)\s+(?:in|to|as|into)\s+([a-z°][a-z°/0-9]*)$/i;

/**
 * Parse "5 km in miles", "72 f to c", "2*3 ft to inches", "5km to mi".
 * @returns {{value:number, from:string, to:string, text:string}|null}
 */
export function convert(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_LENGTH)
        return null;
    const q = text.trim();
    const m = UNIT_RE_TIGHT.exec(q) ?? UNIT_RE.exec(q);
    if (!m)
        return null;
    const [, amountText, fromName, toName] = m;
    if (!findUnit(fromName) || !findUnit(toName))
        return null;
    const amount = calculate(amountText) ?? (/^\s*-?\d+(?:\.\d+)?\s*$/.test(amountText)
        ? { value: Number(amountText) } : null);
    if (!amount)
        return null;
    const out = convertUnits(amount.value, fromName, toName);
    if (out === null)
        return null;
    return {
        value: out,
        from: fromName,
        to: toName,
        text: `${formatNumber(out)} ${labelFor(toName.toLowerCase())}`,
    };
}

/**
 * Entry for the UI: a unit conversion wins over arithmetic.
 * @returns {{kind:'unit'|'math', value:number, text:string, expression:string}|null}
 */
export function evaluateQuery(query) {
    const q = (query ?? '').trim();
    if (!q)
        return null;
    const unit = convert(q);
    if (unit)
        return { kind: 'unit', value: unit.value, text: unit.text, expression: q };
    const math = calculate(q);
    if (math)
        return { kind: 'math', value: math.value, text: math.text, expression: q };
    return null;
}
