/**
 * KissKH Token Generator (Native Node.js Port)
 * Optimized version: Pre-rotated string table for instant startup.
 */

const _0x54b9 = [
    "39aXORCP","toUpperCase","87280owbbkp","6AzawBg","fromCharCode","toString","splice","mg3c3b04ba","substr","9634ttJadP","length","referrer","499416bEetdB","platform","appCodeName","navigator","359664FzBQCJ","12yJxJzi","userAgent","1065160icGOUk","toLowerCase","document","push","charCodeAt","undefined","178276lBUtOp","join","1766601DKvkfN"
];

function _0x3a8d(_0x3a8df2) {
    _0x3a8df2 = _0x3a8df2 - 0x10a;
    return _0x54b9[_0x3a8df2];
}

const generateKissKHToken = (function () {
    const _xb = _0x3a8d;

    function _0x1b25b9(_0x3378d3) {
        const _b4 = _xb, _18 = _0x3378d3[_b4(0x114)], _5a = [];
        for (let _2c = 0; _2c < _18; _2c++) _5a[_2c >>> 0x2] |= (0xff & _0x3378d3[_b4(0x121)](_2c)) << 0x18 - _2c % 4 * 0x8;
        return [_5a, _18];
    }

    function _0x1c779c(_0x3f, _45) {
        const _32 = _xb, _22 = [];
        for (let _44 = 0; _44 < _45; _44++) {
            _22[_32(0x120)]((_0x3f[_44 >>> 0x2] >>> 0x18 - _44 % 4 * 0x8 & 0xff)[_32(0x10f)](0x10)['padStart'](0x2, '0'));
        }
        return _22[_32(0x124)]('');
    }

    function _0x12af79(_0x4d) { return (_0x4d || '')[_xb(0x112)](0, 0x30); }

    function _0x70dbf4(_0x52) {
        const _1d = _xb;
        let _10 = 0;
        for (let _41 = 0; _41 < _0x52[_1d(0x114)]; _41++) _10 = (_10 << 5) - _10 + _0x52[_1d(0x121)](_41);
        return _10;
    }

    function _0x29e11d(_0x44) {
        const _25 = _xb, _38 = 16 - _0x44[_25(0x114)] % 16;
        for (let _12 = 0; _12 < _38; ++_12) _0x44 += String[_25(0x10e)](_38);
        return _0x44;
    }

    function _0xaf4f42(_0x14) {
        const _38 = _xb;
        for (let _383 = 0; _383 < _0x14[_38(0x114)]; _383 += 4) _3505d7(_0x14, _383);
    }

    const _6b = [[0x4f6bdaa3, -0x61d07350, 0x7f5e722d, -0x61210cec, 0x536620a8, -0x32b653e8, -0x4de821cb, 0x2cc92d21, -0x73412227, 0x41f771c1, -0xc1f500c, -0x20d67d2b, 0x2dadde47, 0x6c5aaf86, -0x6045ff8e, 0x409382a7, -0x6417db2, -0x6a1bd238, 0xa5e2dba, 0x4acdaf1d, 0x54c72698, -0x3edcf4b0, -0x3482d916, -0x7e4f7609, -0x6c9fb16c, 0x524345c4, -0x66c19cd2, 0x188eead9, -0x351884c7, -0x675bc103, 0x19a5dd3, 0x1914b70a, -0x4fb1e313, 0x28ea2210, 0x29707fc3, 0x3064c8c9, -0x17593e17, -0x3fb31c07, -0x16c363c6, -0x26a7ab0d, -0x4b793324, 0x74ca2f25, -0x62094ce1, 0x44aee7ec]];
    (function () {
        const _52 = _xb;
        var _43 = [], _42 = [], _b4 = [], _25 = [], _5d = [], _2d = [];
        for (let _21 = 0; _21 < 0x100; _21++) _2d[_21] = _21 < 0x80 ? _21 << 1 : _21 << 1 ^ 0x11b;
        var _211 = 0, _1a = 0;
        for (let _11 = 0; _11 < 0x100; _11++) {
            var _50 = _1a ^ _1a << 1 ^ _1a << 2 ^ _1a << 3 ^ _1a << 4;
            _50 = _50 >>> 8 ^ 0xff & _50 ^ 0x63, _43[_211] = _50;
            var _58 = _2d[_211], _35 = _2d[_2d[_58]], _41 = 0x101 * _2d[_50] ^ 0x1010100 * _50;
            _42[_211] = _41 << 24 | _41 >>> 8, _b4[_211] = _41 << 16 | _41 >>> 16, _25[_211] = _41 << 8 | _41 >>> 24, _5d[_211] = _41, _211 ? (_211 = _58 ^ _2d[_2d[_2d[_35 ^ _58]]], _1a ^= _2d[_2d[_1a]]) : _211 = _1a = 1;
        }
        _6b.push(_42), _6b[_52(0x120)](_b4), _6b[_52(0x120)](_25), _6b.push(_5d), _6b[_52(0x120)](_43);
    }());

    function _3505d7(_13, _5b) {
        const [_45, _32, _53, _48, _3c, _12] = _6b;
        let _21;
        _5b === 0 ? _21 = [0x1504af3, 0x56e619cf, 0x2e42bba6, -0x73c08f07] : _21 = _13.slice(_5b - 4, _5b);
        for (let _5b9 = 0; _5b9 < 4; _5b9++) _13[_5b + _5b9] ^= _21[_5b9];
        var _11 = 10, _4d = _13[_5b] ^ _45[0], _1f = _13[_5b + 1] ^ _45[1], _59 = _13[_5b + 2] ^ _45[2], _22 = _13[_5b + 3] ^ _45[3], _cb = 4;
        for (let _5e = 1; _5e < _11; _5e++) {
            var _34 = _32[_4d >>> 24] ^ _53[_1f >>> 16 & 0xff] ^ _48[_59 >>> 8 & 0xff] ^ _3c[0xff & _22] ^ _45[_cb++],
                _42d = _32[_1f >>> 24] ^ _53[_59 >>> 16 & 0xff] ^ _48[_22 >>> 8 & 0xff] ^ _3c[0xff & _4d] ^ _45[_cb++],
                _4a = _32[_59 >>> 24] ^ _53[_22 >>> 16 & 0xff] ^ _48[_4d >>> 8 & 0xff] ^ _3c[0xff & _1f] ^ _45[_cb++];
            _22 = _32[_22 >>> 24] ^ _53[_4d >>> 16 & 0xff] ^ _48[_1f >>> 8 & 0xff] ^ _3c[0xff & _59] ^ _45[_cb++], _4d = _34, _1f = _42d, _59 = _4a;
        }
        _34 = (_12[_4d >>> 24] << 24 | _12[_1f >>> 16 & 0xff] << 16 | _12[_59 >>> 8 & 0xff] << 8 | _12[0xff & _22]) ^ _45[_cb++],
            _42d = (_12[_1f >>> 24] << 24 | _12[_59 >>> 16 & 0xff] << 16 | _12[_22 >>> 8 & 0xff] << 8 | _12[0xff & _4d]) ^ _45[_cb++],
            _4a = (_12[_59 >>> 24] << 24 | _12[_22 >>> 16 & 0xff] << 16 | _12[_4d >>> 8 & 0xff] << 8 | _12[0xff & _1f]) ^ _45[_cb++],
            _22 = (_12[_22 >>> 24] << 24 | _12[_4d >>> 16 & 0xff] << 16 | _12[_1f >>> 8 & 0xff] << 8 | _12[0xff & _59]) ^ _45[_cb++],
            _13[_5b] = _34, _13[_5b + 1] = _42d, _13[_5b + 2] = _4a, _13[_5b + 3] = _22;
    }

    /**
     * Arguments mapping based on Python reverse-engineering:
     * 1: id
     * 2: guid (viGuid or null)
     * 3: appVer ("2.8.10")
     * 4: somethingElse (viGuid again?)
     * 5: platformVer (4830201)
     * ...etc
     */
    return function (id, guid, appVer, viGuid, platformVer, arg6, arg7, arg8, arg9, arg10, arg11) {
        const _s = _xb;
        
        // Match the exact 15-item array structure from common.js before checksum insertion
        const meta = [
            '', 
            id,          // arg1
            guid,        // arg2
            'mg3c3b04ba', // The missing harcoded secret!
            appVer,      // arg3
            viGuid,      // arg4
            platformVer, // arg5
            _0x12af79(arg6),
            _0x12af79(arg7 ? arg7.toLowerCase() : ''),
            _0x12af79(arg8),
            arg9,
            arg10,
            arg11,
            '00', 
            ''
        ];

        // Insert checksum at index 1
        meta.splice(1, 0, _0x70dbf4(meta.join('|')));

        const raw = _0x29e11d(meta.join('|'));
        const [_words, _len] = _0x1b25b9(raw);
        _0xaf4f42(_words);
        return _0x1c779c(_words, _len)[_s(0x10b)]();
    };
})();

export default generateKissKHToken;
