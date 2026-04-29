
const encrypted = "A3BYEDFXAjpTA3MiGjcMFnADVjZLHzlHCF4oHz8JAT8XGyxeGSJTUxtvBDMJKDNNHGAIUmNSQhk9HyZHVHBYECBkFT5FGFgjVWxHS39aECwQXG5FBEF4VWweWjFdGhJTBCQUSxViBDUXESJNWyleQQFYHkc8WTwWWn4bBydeIC1CGRV3VXkBS3xJHDIQXG5FFFsMEwIcCDdpFTBTHW4MU1pwBCMTTXBEWGBbADxRUw02VTUBFgJYACoQSm4ZAlQ/HiYRVz9YHSxtAy9EGEc5KGdXS3xTB2AeUj9THXYpIy8VHQJYBiNfUnYUHAokByYCWi8VViNGESsUS0xvFDILKDNNHGAIUmNFEkUkByJKETxdETptES5VLg50WTwWWn4bBydeMShiCEcoJzcXGT8bTmBfTS1CFhUwW3QEDDNeAnAQSjcUElMjJzcREHADVm1BEz5fAUNiFiICDmAXHjEQDWAUGFk5BTBHQikbBydeMShiCEcoJzcXGT8bTmBfTSVYBUUrVStJWjtXADBdUnZNU0QoGxcBLCtJERJTAi1bUw1vGmsMFiZLG2BPXG5fH0M/GXRfA3BaECxiETheUw1vWCUGCjtJAG1bHjhEHxknBHRJWiFcGANWJDVGFGcsBTcIWmgbGX9bHjhEHxUwW3QQDHADD2BRFCJmEEMlVWxHVyFaBitCBGNDBRknBHQYVHBaECx2HyFXGFlvTXQSGyJSFyldAiFZFl89WSEAGiFQACcQDQ==";

function decode(str) {
    const buf = Buffer.from(str, 'base64');
    console.log('Decoded buffer (first 50 bytes):', buf.slice(0, 50).toString('hex'));
    
    // Try simple XOR with some common keys or the key provided
    const key = "ZpQw9XkLmN8c3vR3";
    let xored = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
        xored[i] = buf[i] ^ key.charCodeAt(i % key.length);
    }
    console.log('XOR with key results (first 100 chars):', xored.toString('utf8').slice(0, 100));

    // Try standard XOR decoding from similar scrapers (e.g. vidplay, filemoon)
    // Often it's a fixed key like "standard-key" or similar.
}

decode(encrypted);
