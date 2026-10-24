`hello-world.png` and `thank-you.png` are the upstream AccuScan held-out-font
sample images `sample-1.png` and `sample-4.png`, from commit
`faf7bdf130f70165234911d40dde5aa37e503ce0`, used under the MIT license in
`public/handwriting/AccuScan-LICENSE.txt`. They check integration, not independent
real-pen accuracy. `t.png` is a programmatically drawn two-line capital T.

`tests/fixtures/handwriting-hello-input.f32` is the preprocessed float32 tensor
for `hello-world.png`, with shape `[1, 1, 64, 296]` and little-endian values.
The numeric parity fixture is generated from a synthetic four-stroke sharp;
its expected confidence was computed with NumPy independently of the JS
forward pass.
