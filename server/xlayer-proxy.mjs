const ENDPOINTS = new Set(['address/normal-transaction-list-multi', 'address/internal-transaction-list', 'address/token-transaction-list', 'transaction/internal-transaction-detail']);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export function validateQuery(input) {
  if (!input || !ENDPOINTS.has(input.endpoint)) throw Error('只允许已配置的只读历史接口');
  const source = input.params || {}, params = { chainShortName: 'xlayer' };
  const allowed = new Set(['page', 'limit', 'address', 'startBlockHeight', 'endBlockHeight', 'protocolType', 'txId', 'isFromOrTo']);
  if (Object.keys(source).some(k => !allowed.has(k))) throw Error('不支持的查询参数');
  for (const k of ['page', 'limit', 'startBlockHeight', 'endBlockHeight']) if (source[k] != null) {
    if (!/^\d{1,12}$/.test(String(source[k]))) throw Error('无效分页或区块参数');
    params[k] = String(source[k]);
  }
  if (Number(params.page || 1) < 1 || Number(params.page || 1) > 10000 || Number(params.limit || 50) < 1 || Number(params.limit || 50) > 100) throw Error('分页超出范围');
  if (input.endpoint.startsWith('address/')) {
    if (!/^0x[\da-fA-F]{40}$/.test(source.address || '')) throw Error('只查询当前账本地址');
    params.address = source.address.toLowerCase();
    if(source.isFromOrTo!=null){if(!['from','to'].includes(source.isFromOrTo))throw Error('无效方向');params.isFromOrTo=source.isFromOrTo;}
    if (params.startBlockHeight == null || params.endBlockHeight == null || Number(params.endBlockHeight) < Number(params.startBlockHeight)) throw Error('必须提供完整区块范围');
    if (input.endpoint.endsWith('normal-transaction-list-multi') && Number(params.endBlockHeight) - Number(params.startBlockHeight) > 10000) throw Error('普通交易查询区间不能超过一万区块');
  } else {
    if (!/^0x[\da-fA-F]{64}$/.test(source.txId || '')) throw Error('无效交易哈希');
    params.txId = source.txId.toLowerCase();
  }
  if (input.endpoint.endsWith('token-transaction-list')) params.protocolType = 'token_20';
  return '/api/v5/xlayer/' + input.endpoint + '?' + new URLSearchParams(params);
}
export async function signRequest(secret, timestamp, path) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + 'GET' + path)));
  return btoa(String.fromCharCode(...bytes));
}
export async function handleXLayer(request, fetcher = fetch) {
  const origin = new URL(request.url).origin;
  if (request.method !== 'POST') return reply(405, { message: '只接受查询请求' });
  if (request.headers.get('Origin') !== origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return reply(403, { message: '请求来源不匹配' });
  if (Number(request.headers.get('Content-Length') || 0) > 16384) return reply(413, { message: '请求过大' });
  let stage='parse', secrets=[];
  try {
    const body = await request.text(); if (body.length > 16384) return reply(413, { message: '请求过大' });
    const input = JSON.parse(body), creds = input.credentials;
    if (!creds || ['key', 'secret', 'passphrase'].some(k => typeof creds[k] !== 'string' || !creds[k].length || creds[k].length > 512 || /[\r\n]/.test(creds[k]))) return reply(400, { message: '请填写三项 OKX 开发者凭证' });
    secrets=Object.values(creds);stage='validate';
    const path = validateQuery(input), timestamp = new Date().toISOString();
    stage='sign';
    const signature = await signRequest(creds.secret, timestamp, path);
    stage='fetch';
    const upstream = await fetcher('https://web3.okx.com' + path, { method: 'GET', redirect: 'manual', headers: {
      'OK-ACCESS-KEY': creds.key, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-PASSPHRASE': creds.passphrase, 'OK-ACCESS-TIMESTAMP': timestamp
    }, signal: AbortSignal.timeout(25000) });
    // Never forward authentication headers, provider error strings, or payment challenges.
    if (upstream.status === 402) return reply(402, { message: '免费额度不可用，查询已停止；不会自动付费' });
    if (upstream.status === 429) return reply(429, { message: '查询限流，请稍后继续' });
    if (!upstream.ok) return reply(upstream.status === 401 || upstream.status === 403 ? 401 : 502, { message: 'OKX 查询未通过，请检查凭证、权限或免费额度' });
    const result = await upstream.json();
    if (String(result.code) !== '0' || !Array.isArray(result.data)) return reply(422, { message: 'OKX 未返回成功数据，请检查权限、免费额度和本机时间' });
    return reply(200, { data: result.data });
  } catch(e) { let msg=String(e.message||'');for(const secret of secrets)if(secret)msg=msg.split(secret).join('[已隐藏]');msg=msg.replace(/https?:\/\/[^\s]+/g,'[接口地址]').slice(0,180);return reply(stage==='validate'||stage==='parse'?400:502,{message:`OKX ${stage} ${e.name}: ${msg}`}); }
}
