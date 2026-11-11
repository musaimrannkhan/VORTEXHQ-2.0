// VORTEX Advanced Research Engine — completed-candle, explainable, simulation-only.
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const avg = a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const ema = (a,p)=>{if(!a.length)return[];const k=2/(p+1),o=[a[0]];for(let i=1;i<a.length;i++)o.push(a[i]*k+o[i-1]*(1-k));return o;};
const rsi = (a,p=14)=>{const o=Array(a.length).fill(50);if(a.length<=p)return o;let g=0,l=0;for(let i=1;i<=p;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o[i]=al===0?100:100-100/(1+ag/al);}return o;};
function atrOf(c,p=14){const tr=c.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[i-1].close),Math.abs(x.low-c[i-1].close)):x.high-x.low);return ema(tr,p);}
function pivots(c,span=2){const highs=[],lows=[];for(let i=span;i<c.length-span;i++){let hi=true,lo=true;for(let j=1;j<=span;j++){if(c[i].high<c[i-j].high||c[i].high<=c[i+j].high)hi=false;if(c[i].low>c[i-j].low||c[i].low>=c[i+j].low)lo=false;}if(hi)highs.push({price:c[i].high,index:i});if(lo)lows.push({price:c[i].low,index:i});}return{highs,lows};}
export function analyseCandles(raw,timeframe='15m'){
 const c=(raw||[]).slice(0,-1); if(c.length<210)return{ready:false,reason:'Need at least 210 completed candles',timeframe};
 const cl=c.map(x=>x.close),hi=c.map(x=>x.high),lo=c.map(x=>x.low),vo=c.map(x=>x.volume),i=c.length-1,p=cl[i];
 const e9=ema(cl,9),e21=ema(cl,21),e50=ema(cl,50),e200=ema(cl,200),rr=rsi(cl),atr=atrOf(c),a=atr[i],atrPct=a/p*100;
 const f=ema(cl,12),sl=ema(cl,26),m=f.map((v,j)=>v-sl[j]),ms=ema(m,9);
 const plus=[],minus=[];for(let j=0;j<c.length;j++){const up=j?hi[j]-hi[j-1]:0,dn=j?lo[j-1]-lo[j]:0;plus.push(up>dn&&up>0?up:0);minus.push(dn>up&&dn>0?dn:0);}
 const pdi=ema(plus,14).map((v,j)=>atr[j]?100*v/atr[j]:0),mdi=ema(minus,14).map((v,j)=>atr[j]?100*v/atr[j]:0),dx=pdi.map((v,j)=>v+mdi[j]?100*Math.abs(v-mdi[j])/(v+mdi[j]):0),adx=ema(dx,14)[i];
 const volAvg=avg(vo.slice(i-20,i)),volRatio=volAvg?vo[i]/volAvg:0;
 const typical=c.slice(i-49,i+1),vsum=typical.reduce((s,x)=>s+x.volume,0),vwap=vsum?typical.reduce((s,x)=>s+((x.high+x.low+x.close)/3)*x.volume,0)/vsum:p;
 const mf= c.slice(i-19,i+1).reduce((s,x)=>s+(x.high!==x.low?((2*x.close-x.high-x.low)/(x.high-x.low))*x.volume:0),0),mvol= c.slice(i-19,i+1).reduce((s,x)=>s+x.volume,0),cmf=mvol?mf/mvol:0;
 const pv=pivots(c.slice(Math.max(0,i-100),i+1),2),lastHigh=pv.highs.at(-1)?.price||Math.max(...hi.slice(i-20,i)),lastLow=pv.lows.at(-1)?.price||Math.min(...lo.slice(i-20,i));
 const prevRangeHigh=Math.max(...hi.slice(i-20,i)),prevRangeLow=Math.min(...lo.slice(i-20,i));
 const bullStack=e9[i]>e21[i]&&e21[i]>e50[i]&&p>e200[i],bearStack=e9[i]<e21[i]&&e21[i]<e50[i]&&p<e200[i];
 const trend=adx>=22?(bullStack?'UPTREND':bearStack?'DOWNTREND':'TREND-TRANSITION'):'RANGE / WEAK TREND';
 const regime=atrPct>3.2?'EXTREME VOLATILITY':atrPct>1.7?'HIGH VOLATILITY':adx>=22?'TRENDING':adx<16?'RANGING':'TRANSITION';
 const upBreak=p>prevRangeHigh&&volRatio>1.35,downBreak=p<prevRangeLow&&volRatio>1.35;
 const failedUp=c[i].high>prevRangeHigh&&p<prevRangeHigh,failedDown=c[i].low<prevRangeLow&&p>prevRangeLow;
 const bull={trend:bullStack?18:0,emaMomentum:e9[i]>e21[i]?8:0,macro:e50[i]>e200[i]?8:0,rsi:rr[i]>=52&&rr[i]<=72?8:0,macd:m[i]>ms[i]?8:0,vwap:p>vwap?7:0,volume:volRatio>=1.25?9:0,flow:cmf>0.05?8:0,directional:pdi[i]>mdi[i]?7:0,structure:upBreak?12:(p>lastHigh?7:0)};
 const bear={trend:bearStack?18:0,emaMomentum:e9[i]<e21[i]?8:0,macro:e50[i]<e200[i]?8:0,rsi:rr[i]<=48&&rr[i]>=28?8:0,macd:m[i]<ms[i]?8:0,vwap:p<vwap?7:0,volume:volRatio>=1.25?9:0,flow:cmf<-.05?8:0,directional:mdi[i]>pdi[i]?7:0,structure:downBreak?12:(p<lastLow?7:0)};
 const bullScore=Object.values(bull).reduce((s,x)=>s+x,0),bearScore=Object.values(bear).reduce((s,x)=>s+x,0);
 const direction=bullScore>bearScore?'LONG_BIAS':bearScore>bullScore?'SHORT_BIAS':'NEUTRAL';const score=Math.max(bullScore,bearScore);const margin=Math.abs(bullScore-bearScore);
 const conflicts=(bullStack&&rr[i]>76)||(bearStack&&rr[i]<24)||(regime==='EXTREME VOLATILITY')||(!bullStack&&!bearStack&&adx<18);
 const quality=score>=78&&margin>=20&&!conflicts?'A':score>=68&&margin>=16&&!conflicts?'B':score>=56&&margin>=12?'C':'WATCH';
 const qualified=(quality==='A'||quality==='B')&&((direction==='LONG_BIAS'&&bullStack)||(direction==='SHORT_BIAS'&&bearStack))&&regime!=='EXTREME VOLATILITY';
 const side=qualified?(direction==='LONG_BIAS'?'LONG RESEARCH SETUP':'SHORT RESEARCH SETUP'):'NO QUALIFIED SETUP';
 const invalidation=direction==='LONG_BIAS'?Math.min(lastLow,p-1.25*a):Math.max(lastHigh,p+1.25*a);
 const levels={reference:p,atr:a,invalidation,nearSupport:lastLow,nearResistance:lastHigh};
 const evidence=[`${bullStack?'Bullish':bearStack?'Bearish':'Mixed'} EMA 9/21/50/200 alignment`,`RSI(14) ${rr[i].toFixed(1)}`,`MACD histogram ${(m[i]-ms[i]).toPrecision(5)}`,`ADX(14) ${adx.toFixed(1)} · +DI ${pdi[i].toFixed(1)} / -DI ${mdi[i].toFixed(1)}`,`Volume ${volRatio.toFixed(2)}x 20-candle average`,`VWAP ${p>=vwap?'below price':'above price'}`,`CMF(20) ${cmf.toFixed(3)}`,`ATR ${atrPct.toFixed(2)}% · ${regime}`,`Structure ${upBreak?'upside range break':downBreak?'downside range break':failedUp?'failed upside break':failedDown?'failed downside break':'no range break'}`];
 return{ready:true,time:c[i].time,timeframe,price:p,trend,regime,direction,side,score,quality,margin,qualified,conflicts,bullScore,bearScore,rsi:rr[i],macd:m[i],macdSignal:ms[i],adx,plusDI:pdi[i],minusDI:mdi[i],atrPercent:atrPct,volumeRatio:volRatio,vwap,cmf,support:lastLow,resistance:lastHigh,breakoutUp:upBreak,breakoutDown:downBreak,falseUp:failedUp,falseDown:failedDown,levels,evidence,scoredAt:Date.now()};
}
export function combineTimeframes(frames){const order=['5m','15m','1h','4h','1d','1w'];const valid=order.map(k=>frames?.[k]).filter(x=>x?.ready);if(!valid.length)return{ready:false};const long=valid.filter(x=>x.direction==='LONG_BIAS').length,short=valid.filter(x=>x.direction==='SHORT_BIAS').length;const weighted=valid.reduce((s,x)=>s+(x.direction==='LONG_BIAS'?1:x.direction==='SHORT_BIAS'?-1:0)*({ '5m':1,'15m':1.5,'1h':2.5,'4h':3.5,'1d':4.5,'1w':5.5 }[x.timeframe]||1),0);const max=valid.reduce((s,x)=>s+({'5m':1,'15m':1.5,'1h':2.5,'4h':3.5,'1d':4.5,'1w':5.5}[x.timeframe]||1),0);const alignment=Math.round(Math.abs(weighted)/max*100);const bias=weighted>0?'LONG_BIAS':weighted<0?'SHORT_BIAS':'NEUTRAL';const higher=valid.filter(x=>['1h','4h','1d','1w'].includes(x.timeframe));const higherAgree=higher.length>0&&higher.every(x=>x.direction===bias);return{ready:true,bias,alignment,longFrames:long,shortFrames:short,frames:valid.length,higherAgree,qualified:alignment>=65&&higherAgree&&valid.some(x=>x.qualified),summary:`${alignment}% weighted timeframe alignment · ${higherAgree?'higher timeframes agree':'higher-timeframe confirmation missing'}`};}

// Spot has a separate long-horizon thesis model: no short-side setup labels.
export function analyseSpotCandles(raw, timeframe='1d') {
  const base = analyseCandles(raw, timeframe);
  if (!base.ready) return { ...base, marketMode: 'SPOT' };
  const longHorizon = timeframe === '1d' || timeframe === '1w';
  const closes = (raw || []).slice(0, -1).map(x => x.close);
  const ema200 = ema(closes, 200).at(-1) || base.price;
  const trendHealthy = base.direction === 'LONG_BIAS' && base.price > ema200;
  const flowHealthy = base.cmf > 0.04 && base.volumeRatio >= 0.9;
  const momentumHealthy = base.rsi >= 45 && base.rsi <= 72;
  const structureHealthy = !base.falseUp && !base.breakoutDown && base.price > base.support;
  const thesisScore = [trendHealthy, flowHealthy, momentumHealthy, structureHealthy].filter(Boolean).length;
  const distributionRisk = base.direction === 'SHORT_BIAS' || (base.cmf < -0.08 && base.price < base.ema50);
  const phase = distributionRisk ? 'DISTRIBUTION / THESIS RISK' : thesisScore >= 3 && longHorizon ? 'ACCUMULATION / HOLDING-STRENGTH WATCH' : 'NEUTRAL / BUILDING EVIDENCE';
  return {
    ...base, marketMode: 'SPOT', ema200, phase, thesisScore, thesisChecks: { trendHealthy, flowHealthy, momentumHealthy, structureHealthy },
    distributionRisk, displayDirection: distributionRisk ? 'THESIS RISK' : (thesisScore >= 3 ? 'HOLDING STRENGTH' : 'NEUTRAL'), qualified: longHorizon && thesisScore >= 3 && !distributionRisk,
    side: longHorizon && thesisScore >= 3 && !distributionRisk ? 'SPOT HOLDING-THESIS WATCH' : 'NO QUALIFIED SPOT THESIS',
    holdingHorizon: timeframe === '1w' ? 'WEEKLY CYCLE' : 'DAILY STRUCTURE',
    evidence: [...base.evidence, `Spot thesis checks ${thesisScore}/4`, `Holding phase: ${phase}`, `Horizon: ${timeframe === '1w' ? 'weekly cycle' : 'daily structure'}`]
  };
}
