import {seedState,validateState,applyCommand} from './core.mjs';

export class StorageConflictError extends Error {
  constructor(){super('Бюджет изменён в другой вкладке.');this.name='StorageConflictError'}
}
export function checkEnvelope(row){
  if(!row||!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('Не удалось прочитать сохранённый бюджет. Данные не заменены.');
  validateState(row.state);return row;
}
export function nextEnvelope(row,revision,command){
  if(!Number.isSafeInteger(revision)||revision<0)throw Error('Некорректная версия бюджета.');
  checkEnvelope(row);
  if(row.revision!==revision)throw new StorageConflictError();
  if(revision===Number.MAX_SAFE_INTEGER)throw Error('Достигнут предел версий. Скачайте резервную копию.');
  return {revision:revision+1,state:applyCommand(row.state,command),savedAt:new Date().toISOString()};
}
const fresh=()=>({revision:0,state:seedState(),savedAt:null});
const storageError=error=>error?.name==='QuotaExceededError'?Error('Недостаточно места в браузере. Скачайте копию бюджета и освободите место. Изменение не сохранено.'):error||Error('Браузер не подтвердил сохранение.');

/** One atomic read-modify-write transaction prevents stale tabs overwriting a budget. */
export function createBrowserStore({factory=globalThis.indexedDB,name='spokoino-budget:'+new URL('./',import.meta.url).pathname}={}){
  let connection;
  function open(){
    if(!factory)return Promise.reject(Error('Браузер запретил хранение данных. Разрешите данные сайта и откройте его в обычном режиме.'));
    if(connection)return connection;
    connection=new Promise((resolve,reject)=>{
      let request;
      try{request=factory.open(name,1)}catch(error){reject(storageError(error));return}
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('budget'))request.result.createObjectStore('budget')};
      request.onerror=()=>reject(storageError(request.error));
      request.onblocked=()=>{connection=null;reject(Error('Закройте другие вкладки бюджета и повторите открытие.'))};
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null};resolve(db)};
    }).catch(error=>{connection=null;throw error});
    return connection;
  }
  async function transact(mode,process){
    const db=await open();
    return new Promise((resolve,reject)=>{
      let tx,result,failure;
      try{tx=db.transaction('budget',mode);const objects=tx.objectStore('budget');const get=objects.get('current');
        get.onsuccess=()=>{try{result=process(get.result??fresh(),objects)}catch(error){failure=error;tx.abort()}};
        get.onerror=()=>{failure=get.error};
        tx.oncomplete=()=>resolve(structuredClone(result));
        tx.onabort=()=>reject(storageError(failure||tx.error));
        tx.onerror=()=>{failure=failure||tx.error};
      }catch(error){reject(storageError(error))}
    });
  }
  return {
    read:()=>transact('readonly',row=>checkEnvelope(row)),
    write:(revision,command)=>transact('readwrite',(row,objects)=>{const next=nextEnvelope(row,revision,command);objects.put(next,'current');return next}),
    async close(){const pending=connection;connection=null;if(pending)(await pending).close()}
  };
}
