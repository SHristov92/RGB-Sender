// Prints the test vectors quoted in docs/SPEC.md (section 10).
import { buildTransmission, frameToSlots, PALETTE, CONTENT_TYPE, MODE } from '../js/protocol.js';
import { rsEncode } from '../js/rs.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const letters = (slots) => Array.from(slots, (c) => PALETTE[c].key).join('');

for (const mode of [MODE.ROBUST, MODE.DENSE]) {
  const tx = buildTransmission(CONTENT_TYPE.TEXT, new TextEncoder().encode('Hi'), { mode, eccT: 4 });
  const f = tx.frames[0];
  console.log(`## mode ${mode} (${mode === MODE.ROBUST ? 'robust' : 'dense'}), message "Hi", t = 4`);
  console.log('envelope        ', hex(tx.envelope));
  console.log('header info     ', hex(f.headerInfo));
  console.log('header codeword ', hex(rsEncode(f.headerInfo, 8)));
  console.log('body codeword   ', hex(rsEncode(f.body, 2 * f.t)));
  console.log('slots           ', letters(frameToSlots(f)));
  console.log();
}
