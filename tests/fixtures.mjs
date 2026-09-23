import {configureWallets,EVM,SOL} from '../dist/ledger.mjs';
configureWallets('0x1111111111111111111111111111111111111111','So11111111111111111111111111111111111111112');
export const EXAMPLE='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const seed={id:`4663:${EXAMPLE}:fee:20`,chain:'4663',asset:'native',symbol:'ETH',decimals:18,raw:'15000000000000',hash:EXAMPLE,from:'0x3333333333333333333333333333333333333333',to:EVM,trader:'0x2222222222222222222222222222222222222222',direction:'in',kind:'commission',time:'2026-09-23T04:04:21.000Z',evidence:'Synthetic CommissionFromTokenRecord test fixture',verified:true};
