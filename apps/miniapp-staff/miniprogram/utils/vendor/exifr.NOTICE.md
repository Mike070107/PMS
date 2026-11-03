# exifr 7.1.3

Upstream: https://github.com/MikeKovarik/exifr
License: MIT (exifr.LICENSE.txt).
Original full.umd.js SHA256: 2bd05117781c12ddd965dee846de3b3f986b5ecb4c7f6a78f2d2ec1db7c65ae7

Only adaptation: module-local self binding for WeChat. Never pass paths, URLs or user identifiers; caller supplies bytes from the selected original photo. Rebuild with node tools/build-meter-exif.cjs after pnpm install.
