import { webcrypto } from 'node:crypto';
const seed = Buffer.from(process.argv[2], 'hex');
const message = Buffer.from(process.argv[3], 'hex');
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const key = await webcrypto.subtle.importKey('pkcs8', Buffer.concat([prefix, seed]), 'Ed25519', false, ['sign']);
if (key.extractable) throw new Error('The signer key must be non-exportable.');
const signature = await webcrypto.subtle.sign('Ed25519', key, message);
process.stdout.write(Buffer.from(signature).toString('hex'));
