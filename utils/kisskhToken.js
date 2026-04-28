/**
 * KissKH Token Generator (Native Node.js Port)
 * This version uses the raw string table and includes the rotation logic 
 * to ensure perfect mapping of the obfuscated function calls.
 */

const _0x54b9_list = ['join', '1766601DKvkfN', '39aXORCP', 'toUpperCase', '87280owbbkp', '6AzawBg', 'fromCharCode', 'toString', 'splice', 'mg3c3b04ba', 'substr', '9634ttJadP', 'length', 'referrer', '499416bEetdB', 'platform', 'appCodeName', 'navigator', '359664FzBQCJ', '12yJxJzi', 'userAgent', '1065160icGOUk', 'toLowerCase', 'document', 'push', 'charCodeAt', 'undefined', '178276lBUtOp'];

function _0x3a8d(index) {
    return _0x54b9_list[index - 0x10a];
}

// Perform the required table rotation once at load time
(function(_0x2a0650, _0x28a91e) {
    const _0x4955cd = _0x2a0650;
    while (!![]) {
        try {
            const _0x2eca83 = parseInt(_0x3a8d(0x10a)) / 0x1 * (parseInt(_0x3a8d(0x113)) / 0x2) + -parseInt(_0x3a8d(0x10d)) / 0x3 * (parseInt(_0x3a8d(0x116)) / 0x4) + -parseInt(_0x3a8d(0x10c)) / 0x5 * (-parseInt(_0x3a8d(0x11b)) / 0x6) + parseInt(_0x3a8d(0x123)) / 0x7 + parseInt(_0x3a8d(0x11a)) / 0x8 + parseInt(_0x3a8d(0x125)) / 0x9 + -parseInt(_0x3a8d(0x11d)) / 0xa;
            if (_0x2eca83 === _0x28a91e) break;
            else _0x4955cd.push(_0x4955cd.shift());
        } catch (e) {
            _0x4955cd.push(_0x4955cd.shift());
        }
    }
}(_0x54b9_list, 0x20892));

const generateKissKHToken = (function() {
    function _0x1b25b9(_0x3378d3) {
        const _xb = _0x3a8d, _len = _0x3378d3[_xb(0x114)], _words = [];
        for (let i = 0; i < _len; i++) _words[i >>> 0x2] |= (0xff & _0x3378d3[_xb(0x121)](i)) << 0x18 - i % 4 * 0x8;
        return [_words, _len];
    }

    function _0x1c779c(_words, _len) {
        const _xb = _0x3a8d, _hex = [];
        for (let i = 0; i < _len; i++) {
            _hex[_xb(0x120)]((_words[i >>> 0x2] >>> 0x18 - i % 4 * 0x8 & 0xff)[_xb(0x10f)](0x10)['padStart'](0x2, '0'));
        }
        return _hex[_xb(0x124)]('');
    }

    function _0x12af79(s) {
        const _xb = _0x3a8d;
        return (s || '')[_xb(0x112)](0, 0x30);
    }

    function _0x70dbf4(s) {
        const _xb = _0x3a8d;
        let h = 0;
        for (let i = 0; i < s[_xb(0x114)]; i++) h = (h << 5) - h + s[_xb(0x121)](i);
        return h;
    }

    function _0x29e11d(s) {
        const _xb = _0x3a8d, pad = 16 - s[_xb(0x114)] % 16;
        for (let i = 0; i < pad; ++i) s += String[_xb(0x10e)](pad);
        return s;
    }

    function _0xaf4f42(words) {
        for (let i = 0; i < words.length; i += 4) _3505d7(words, i);
    }

    const _6b = [[0x4f6bdaa3, -0x61d07350, 0x7f5e722d, -0x61210cec, 0x536620a8, -0x32b653e8, -0x4de821cb, 0x2cc92d21, -0x73412227, 0x41f771c1, -0xc1f500c, -0x20d67d2b, 0x2dadde47, 0x6c5aaf86, -0x6045ff8e, 0x409382a7, -0x6417db2, -0x6a1bd238, 0xa5e2dba, 0x4acdaf1d, 0x54c72698, -0x3edcf4b0, -0x3482d916, -0x7e4f7609, -0x6c9fb16c, 0x524345c4, -0x66c19cd2, 0x188eead9, -0x351884c7, -0x675bc103, 0x19a5dd3, 0x1914b70a, -0x4fb1e313, 0x28ea2210, 0x29707fc3, 0x3064c8c9, -0x17593e17, -0x3fb31c07, -0x16c363c6, -0x26a7ab0d, -0x4b793324, 0x74ca2f25, -0x62094ce1, 0x44aee7ec]];
    (function() {
        const _43 = [], _42 = [], _b4 = [], _25 = [], _5d = [], _2d = [];
        for (let i = 0; i < 0x100; i++) _2d[i] = i < 0x80 ? i << 1 : i << 1 ^ 0x11b;
        let i2 = 0, i1 = 0;
        for (let i = 0; i < 0x100; i++) {
            let s = i1 ^ i1 << 1 ^ i1 << 2 ^ i1 << 3 ^ i1 << 4;
            s = s >>> 8 ^ 0xff & s ^ 0x63, _43[i2] = s;
            let v = _2d[i2], x = _2d[_2d[v]], t = 0x101 * _2d[s] ^ 0x1010100 * s;
            _42[i2] = t << 24 | t >>> 8, _b4[i2] = t << 16 | t >>> 16, _25[i2] = t << 8 | t >>> 24, _5d[i2] = t, i2 ? (i2 = v ^ _2d[_2d[_2d[x ^ v]]], i1 ^= _2d[_2d[i1]]) : i2 = i1 = 1;
        }
        _6b.push(_42, _b4, _25, _5d, _43);
    }());

    function _3505d7(words, start) {
        const [_45, _32, _53, _48, _3c, _12] = _6b;
        let iv = start === 0 ? [0x1504af3, 0x56e619cf, 0x2e42bba6, -0x73c08f07] : words.slice(start - 4, start);
        for (let i = 0; i < 4; i++) words[start + i] ^= iv[i];
        let w0 = words[start] ^ _45[0], w1 = words[start + 1] ^ _45[1], w2 = words[start + 2] ^ _45[2], w3 = words[start + 3] ^ _45[3], cur = 4;
        for (let i = 1; i < 10; i++) {
            let t0 = _32[w0 >>> 24] ^ _53[w1 >>> 16 & 0xff] ^ _48[w2 >>> 8 & 0xff] ^ _3c[w3 & 0xff] ^ _45[cur++];
            let t1 = _32[w1 >>> 24] ^ _53[w2 >>> 16 & 0xff] ^ _48[w3 >>> 8 & 0xff] ^ _3c[w0 & 0xff] ^ _45[cur++];
            let t2 = _32[w2 >>> 24] ^ _53[w3 >>> 16 & 0xff] ^ _48[w0 >>> 8 & 0xff] ^ _3c[w1 & 0xff] ^ _45[cur++];
            w3 = _32[w3 >>> 24] ^ _53[w0 >>> 16 & 0xff] ^ _48[w1 >>> 8 & 0xff] ^ _3c[w2 & 0xff] ^ _45[cur++];
            w0 = t0; w1 = t1; w2 = t2;
        }
        words[start] = (_12[w0 >>> 24] << 24 | _12[w1 >>> 16 & 0xff] << 16 | _12[w2 >>> 8 & 0xff] << 8 | _12[w3 & 0xff]) ^ _45[cur++];
        words[start + 1] = (_12[w1 >>> 24] << 24 | _12[w2 >>> 16 & 0xff] << 16 | _12[w3 >>> 8 & 0xff] << 8 | _12[w0 & 0xff]) ^ _45[cur++];
        words[start + 2] = (_12[w2 >>> 24] << 24 | _12[w3 >>> 16 & 0xff] << 16 | _12[w0 >>> 8 & 0xff] << 8 | _12[w1 & 0xff]) ^ _45[cur++];
        words[start + 3] = (_12[w3 >>> 24] << 24 | _12[w0 >>> 16 & 0xff] << 16 | _12[w1 >>> 8 & 0xff] << 8 | _12[w2 & 0xff]) ^ _45[cur++];
    }

    return function(id, guid, appVer, viGuid, platformVer, url, ua, referrer, ua2, appName, platform) {
        const _xb = _0x3a8d;
        const meta = ['', id, guid, _xb(0x111), appVer, viGuid, platformVer, _0x12af79(url), _0x12af79(ua.toLowerCase()), _0x12af79(referrer), ua2, appName, platform, '00', ''];
        const rawStr = meta.join('|');
        console.log('META:', rawStr);
        meta.splice(1, 0, _0x70dbf4(rawStr));
        const raw = _0x29e11d(meta.join('|'));
        const [_words, _len] = _0x1b25b9(raw);
        _0xaf4f42(_words);
        const result = _0x1c779c(_words, _len).toUpperCase();
        console.log('TOKEN RESULT:', result);
        return result;
    };
})();

export default generateKissKHToken;
