import {handleLinea} from '../../server/linea-proxy.mjs';
import {handleBlockscout} from '../../server/blockscout-proxy.mjs';
import {handleXLayer} from '../../server/xlayer-proxy.mjs';
import {handlePrices} from '../../server/prices-proxy.mjs';
export default async request=>{const handlers={'/api/linea':handleLinea,'/api/blockscout':handleBlockscout,'/api/xlayer':handleXLayer,'/api/prices':handlePrices};return handlers[new URL(request.url).pathname]?.(request)||new Response('Not found',{status:404})};
export const config={path:'/api/*'};
