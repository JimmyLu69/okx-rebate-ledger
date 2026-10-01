import {handleLinea} from '../../server/linea-proxy.mjs';
import {handleBlockscout} from '../../server/blockscout-proxy.mjs';
import {handleXLayer} from '../../server/xlayer-proxy.mjs';
import {handlePrices} from '../../server/prices-proxy.mjs';
import {relayResponse,withRelaySlot} from '../../server/safety.mjs';
const handlers={'/api/linea':handleLinea,'/api/blockscout':handleBlockscout,'/api/xlayer':handleXLayer,'/api/prices':handlePrices};
export default async request=>{
 const handler=handlers[new URL(request.url).pathname];
 if(!handler)return relayResponse(404,{message:'接口不存在'});
 if(process.env.API_RELAY_DISABLED==='true')return relayResponse(503,{message:'数据转发已由站点维护者暂停，请稍后再试'},{'Retry-After':'300'});
 return withRelaySlot(()=>handler(request));
};
// Netlify enforces this on all plans across function instances, with up to 10s
// propagation delay. Per-IP fair use is not an absolute site-wide spend cap.
// https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/
export const config={path:'/api/*',rateLimit:{windowLimit:360,windowSize:60,aggregateBy:['ip','domain']}};
