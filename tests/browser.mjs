import {createBrowserStore,StorageConflictError} from '../browser-store.mjs';
import {seedState,monthSummary} from '../core.mjs';
import {incomeCommands} from '../forms.mjs';
const out=document.querySelector('#results');
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const makeIncome=(state,id,amount='100')=>incomeCommands(state,'operations',{category:'Зарплата',amount,date:'2026-11-01'},id);
document.querySelector('#run').onclick=async()=>{
  document.querySelector('#run').disabled=true;out.textContent='';let passes=0;
  const name='spokoino-disposable-test-'+crypto.randomUUID();
  let a=createBrowserStore({name}),b=createBrowserStore({name});
  const check=async(label,fn)=>{await fn();passes++;out.textContent+='✓ '+label+'\n'};
  try{
    await check('Пустой бюджет без демонстрационных данных',async()=>{const r=await a.read();assert(r.revision===0&&!r.state.operations.length,'not empty')});
    await check('Доход сохраняется и виден через другое соединение',async()=>{const r=await a.read();await a.write(r.revision,makeIncome(r.state,'first','123,45'));assert(monthSummary((await b.read()).state,'2026-11').income===12345,'not shared')});
    await check('Данные остаются после закрытия и повторного открытия базы',async()=>{await a.close();a=createBrowserStore({name});assert((await a.read()).state.operations[0].amount===12345,'not persisted')});
    await check('Одновременные сохранения: одно успешно, другое получает конфликт',async()=>{const r=await a.read();const results=await Promise.allSettled([a.write(r.revision,makeIncome(r.state,'second')),b.write(r.revision,makeIncome(r.state,'third'))]);assert(results.filter(x=>x.status==='fulfilled').length===1,'wrong successful count');assert(results.some(x=>x.status==='rejected'&&x.reason instanceof StorageConflictError),'missing conflict');assert((await a.read()).state.operations.length===2,'records lost')});
    await check('Ошибка в batch полностью откатывает транзакцию',async()=>{const before=await a.read();try{await a.write(before.revision,{type:'batch',commands:[{type:'upsert',entity:'notes',record:{id:'rollback',date:'2026-11-01',month:'2026-11',title:'',text:'test'}},{type:'upsert',entity:'operations',record:{id:'bad'}}]});throw Error('accepted')}catch(e){assert(e.message!=='accepted','accepted invalid batch')}assert(JSON.stringify(await a.read())===JSON.stringify(before),'partial write')});
    await check('JSON-копия восстанавливается без повторного начисления доходов',async()=>{const before=await a.read();const backup=JSON.parse(JSON.stringify({state:before.state}));await a.write(before.revision,{type:'restore',state:seedState()});const empty=await a.read();assert(!empty.state.operations.length,'reset failed');await a.write(empty.revision,{type:'restore',state:backup.state});assert(JSON.stringify((await a.read()).state)===JSON.stringify(before.state),'restore mismatch')});
    await check('Сбой записи не выдаёт ложное подтверждение сохранения',async()=>{const before=await a.read();const quotaFactory={open(){const req=indexedDB.open(name,1);req.addEventListener('success',()=>{const real=req.result.transaction.bind(req.result);req.result.transaction=(...args)=>{const tx=real(...args);if(args[1]==='readwrite'){const objectStore=tx.objectStore.bind(tx);tx.objectStore=(...args)=>{const objects=objectStore(...args);objects.put=()=>{throw new DOMException('disk full','QuotaExceededError')};return objects}}return tx}});return req}};const q=createBrowserStore({name,factory:quotaFactory});try{await q.write(before.revision,makeIncome(before.state,'quota'));throw Error('accepted')}catch(e){assert(e.message.includes('Недостаточно места'),'missing quota message')}await q.close();assert(JSON.stringify(await a.read())===JSON.stringify(before),'quota changed budget')});
    out.textContent+='\nУспешно: '+passes+'/7';
  }catch(e){out.textContent+='\nОШИБКА: '+e.message}
  finally{await a.close();await b.close();indexedDB.deleteDatabase(name);document.querySelector('#run').disabled=false}
};
