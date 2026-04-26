template Num2Bits(n) {
    signal input in;
    signal output out[n];

    var lc = 0;
    var bit_value = 1;
    for (var i = 0; i < n; i++) {
        out[i] <-- (in \ bit_value) % 2;
        out[i] * (out[i] - 1) === 0;
        lc += out[i] * bit_value;
        bit_value *= 2;
    }
    lc === in;
}

template UniswapV3Slot0() {
    signal input packed;
    signal input sqrtPriceX96;
    signal input tickRaw;
    signal input observationIndex;
    signal input observationCardinality;
    signal input observationCardinalityNext;
    signal input feeProtocol;
    signal input unlockedByte;

    component bits = Num2Bits(248);
    bits.in <== packed;

    var sqrt = 0;
    var tick = 0;
    var obsIndex = 0;
    var obsCard = 0;
    var obsCardNext = 0;
    var fee = 0;
    var unlocked = 0;
    var bit_value;

    bit_value = 1;
    for (var i = 0; i < 160; i++) {
        sqrt += bits.out[i] * bit_value;
        bit_value *= 2;
    }
    sqrt === sqrtPriceX96;

    bit_value = 1;
    for (var j = 160; j < 184; j++) {
        tick += bits.out[j] * bit_value;
        bit_value *= 2;
    }
    tick === tickRaw;

    bit_value = 1;
    for (var k = 184; k < 200; k++) {
        obsIndex += bits.out[k] * bit_value;
        bit_value *= 2;
    }
    obsIndex === observationIndex;

    bit_value = 1;
    for (var l = 200; l < 216; l++) {
        obsCard += bits.out[l] * bit_value;
        bit_value *= 2;
    }
    obsCard === observationCardinality;

    bit_value = 1;
    for (var m = 216; m < 232; m++) {
        obsCardNext += bits.out[m] * bit_value;
        bit_value *= 2;
    }
    obsCardNext === observationCardinalityNext;

    bit_value = 1;
    for (var n = 232; n < 240; n++) {
        fee += bits.out[n] * bit_value;
        bit_value *= 2;
    }
    fee === feeProtocol;

    bit_value = 1;
    for (var p = 240; p < 248; p++) {
        unlocked += bits.out[p] * bit_value;
        bit_value *= 2;
    }
    unlocked === unlockedByte;
}

component main = UniswapV3Slot0();
