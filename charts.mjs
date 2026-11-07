import {money,monthLabel} from './core.mjs';

const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const palette=['#8ea783','#c5a58e','#9aaeb1','#c3b776','#a69ab2','#afbd96','#ccaaa5','#96aaa1','#b8a88d','#9da3bc','#b7b88c','#bd9c83'];
const color = i => palette[i]||'hsl('+Math.round(i*137.508%360)+' 20% 64%)';
const shareLabel = fraction => fraction>0&&fraction<.001?'<0,1%':percent.format(fraction*100)+'%';
const dateLabel = (key,group) => group==='months'?monthLabel(key):key.slice(8)+'.'+key.slice(5,7)+'.'+key.slice(0,4);

/** Display preferences only: never part of the financial record or revision. */
export function readChartTypes(storage){
  const defaults={movement:'bar',categories:'bar'};
  try {const stored=JSON.parse(storage.getItem('spokoino-chart-types')||'{}');for(const key of Object.keys(defaults))if(['bar','pie'].includes(stored?.[key]))defaults[key]=stored[key]} catch {}
  return defaults;
}
export function saveChartTypes(storage,types){
  try {storage.setItem('spokoino-chart-types',JSON.stringify({movement:types.movement==='pie'?'pie':'bar',categories:types.categories==='pie'?'pie':'bar'}))}catch{}
}
export function chartTypeControls(key,type,label){
  return '<div class="chart-type-control" role="group" aria-label="Вид графика: '+escape(label)+'">'+[['bar','Столбцы'],['pie','Круговая']].map(([value,text])=>'<button type="button" data-action="chart-type" data-chart="'+key+'" data-value="'+value+'" aria-pressed="'+(type===value)+'" class="chart-type-button '+(type===value?'active':'')+'">'+text+'</button>').join('')+'</div>';
}
/** Preserve every nonzero value; no invented shares, hidden top-N or rounded sums. */
export function pieParts(rows){
  let total=0;
  const parts=rows.filter(row=>row.value>0).map((row,i)=>{
    if(!Number.isSafeInteger(row.value))throw Error('Сумма диаграммы должна быть в целых копейках.');
    total+=row.value;if(!Number.isSafeInteger(total))throw Error('Сумма диаграммы слишком велика.');
    return {...row,color:color(i)};
  });
  let offset=0,cumulative=0;
  return {total,parts:parts.map((row,i)=>{
    cumulative+=row.value;
    const fraction=row.value/total;
    const end=i===parts.length-1?100:Math.max(offset,Math.min(100,cumulative/total*100));
    const part={...row,fraction,size:end-offset,offset};offset=end;return part;
  })};
}
export function donutChart(rows,title,emptyMessage){
  const {total,parts}=pieParts(rows);
  if(!parts.length)return '<div class="donut-block"><h3>'+escape(title)+'</h3><div class="chart-empty"><div class="empty-ring" aria-hidden="true"></div><p>'+escape(emptyMessage)+'</p></div></div>';
  const formatted=money(total),fontSize=Math.max(9,Math.min(18,105/(formatted.length*.55)));
  const svg='<svg class="donut" viewBox="0 0 200 200" role="img" aria-label="'+escape(title+' · '+formatted)+'" data-total="'+total+'"><title>'+escape(title+' · '+formatted)+'</title><circle cx="100" cy="100" r="73" fill="none" stroke="#eeeede" stroke-width="34"/>'+parts.map(p=>'<circle cx="100" cy="100" r="73" fill="none" stroke="'+p.color+'" stroke-width="34" pathLength="100" stroke-dasharray="'+p.size+' '+(100-p.size)+'" stroke-dashoffset="'+(-p.offset)+'" transform="rotate(-90 100 100)" data-value="'+p.value+'"><title>'+escape(p.label+' · '+money(p.value)+' · '+shareLabel(p.fraction))+'</title></circle>').join('')+'<text x="100" y="94" text-anchor="middle" class="donut-caption">Всего</text><text x="100" y="116" text-anchor="middle" class="donut-total" font-size="'+fontSize+'">'+escape(formatted)+'</text></svg>';
  const legend='<ul class="pie-legend" aria-label="'+escape(title+' — суммы и доли')+'">'+parts.map(p=>'<li><span class="pie-swatch" style="background:'+p.color+'" aria-hidden="true"></span><span class="pie-label">'+escape(p.label)+'</span><span class="pie-numbers">'+escape(money(p.value))+'<small>'+escape(shareLabel(p.fraction))+'</small></span></li>').join('')+'</ul>';
  return '<div class="donut-block"><h3>'+escape(title)+'</h3><div class="donut-body">'+svg+legend+'</div></div>';
}
export function movementChart(groups,{type='bar',group='days',pieGroups=groups,truncated=false}={}){
  if(type==='pie'){
    const suffix=group==='months'?' по месяцам':' по дням';
    return '<p class="chart-description">Каждый круг показывает доли '+(group==='months'?'месяцев':'дней')+' в своей сумме за выбранный период.</p><div class="movement-pies">'+donutChart(pieGroups.map(g=>({label:dateLabel(g.key,group),value:g.income})),'Доходы'+suffix,'Нет доходов за этот период')+donutChart(pieGroups.map(g=>({label:dateLabel(g.key,group),value:g.expense})),'Расходы'+suffix,'Нет расходов за этот период')+'</div>';
  }
  const max=Math.max(1,...groups.flatMap(g=>[g.income,g.expense]));
  return '<div class="calendar-legend"><span><i></i>Доходы</span><span><i class="clay"></i>Расходы</span></div><div class="chart-scroll"><div class="bar-chart">'+groups.map(g=>'<div class="bar-group" title="'+escape(dateLabel(g.key,group)+' · Доход '+money(g.income)+' · Расход '+money(g.expense))+'"><div class="bar" style="height:'+g.income/max*100+'%"></div><div class="bar expense" style="height:'+g.expense/max*100+'%"></div><div class="bar-label">'+escape(group==='months'?g.key.slice(5)+'/'+g.key.slice(2,4):g.key.slice(8)+'.'+g.key.slice(5,7))+'</div></div>').join('')+'</div></div>'+(truncated?'<p class="chart-description">На графике первые '+(group==='months'?'240 месяцев':'366 дней')+'. Круговая диаграмма и итоги учитывают весь выбранный период.</p>':'');
}
export function categoryChart(categories,type='bar'){
  const entries=Object.entries(categories).sort((a,b)=>b[1]-a[1]);
  if(type==='pie')return donutChart(entries.map(([label,value])=>({label,value})),'Расходы по категориям','Нет расходов за выбранный период');
  const total=entries.reduce((sum,[,value])=>sum+value,0);
  return entries.length?entries.map(([label,value])=>'<div class="category-row"><span>'+escape(label)+'</span><div class="progress"><span style="width:'+(total?value/total*100:0)+'%"></span></div><span>'+money(value)+'</span></div>').join(''):'<div class="empty">Нет расходов за выбранный период.</div>';
}
