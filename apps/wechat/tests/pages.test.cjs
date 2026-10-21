'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This suite replaces the former real-provider page flows. It exercises synthetic
// single-card binding, lifecycle invalidation and the stricter no-network/no-GPS/
// no-storage boundary. Real-provider service and account suites remain separate.
const clone = value => JSON.parse(JSON.stringify(value));
const event = dataset => ({currentTarget:{dataset}});
function harness(name, options = {}) {
  let definition;
  const calls=[], operations=[], callbacks=[];
  const old = {VERSION:'test-alpha',state:{consent:false,status:'idle',error:'',config:null}};
  const state = {mode:'VIRTUAL',target:'PACKAGE',origin:{x:500,y:500,label:'虚拟广场'},
    options:{budgetCents:null,maxDistanceUnits:null,vegetarianOnly:false,maxSpicy:null,preferMain:true,weights:{price:1,distance:1,main:1}},
    strategy:'explicit',status:'idle',current:null,revision:0,summary:'虚拟广场 · 预算不限',reasons:['按本次条件决定'],uncertainties:[],counts:{remaining:2},receipt:null};
  let next=0, rendered=null;
  function candidate(index){
    return {id:`virtual-${index}`,revision:state.revision,name:`虚拟套餐 ${index}`,restaurantName:'合成小馆',mealName:'合成午餐',
      priceText:'¥28',distanceText:'120 单位',roleText:'模拟正餐',factsSummary:['虚拟场景价'],reasons:['预算条件符合'],
      uncertainties:[],mode:'VIRTUAL',target:state.target,latitude:'must-not-render',resultToken:'must-not-render',accessToken:'must-not-render'};
  }
  const decision = {
    getState(){return clone(state);},
    configure(patch){
      operations.push({type:'configure',patch:clone(patch)});
      if(patch.target)state.target=patch.target;
      if(Object.hasOwn(patch,'origin'))state.origin=clone(patch.origin);
      if(patch.options)state.options={...state.options,...clone(patch.options)};
      if(patch.strategy)state.strategy=patch.strategy;
      state.revision++;state.current=null;state.status='idle';rendered=null;next=0;
      return clone(state);
    },
    recommend({reroll=false}={}){
      operations.push({type:'recommend',reroll});
      if(options.recommendError)throw new Error('合成决策错误');
      if(state.status==='recommended'&&!reroll)return clone(state);
      if(next>=2){state.current=null;state.status='exhausted';state.revision++;return clone(state);}
      state.revision++;state.current=candidate(next++);state.status='recommended';rendered=null;return clone(state);
    },
    resolve(id,revision){return state.current&&state.current.id===id&&state.revision===revision?clone(state.current):null;},
    markRendered(binding){if(this.resolve(binding.candidateId,binding.revision)){rendered=clone(binding);operations.push({type:'render',...clone(binding)});}},
    confirm(binding){
      assert.deepEqual(clone(binding),rendered,'only a completed render may be confirmed');
      assert.ok(this.resolve(binding.candidateId,binding.revision),'stale revision cannot be confirmed');
      if(options.confirmError)throw new Error('合成确认错误');
      operations.push({type:'confirm',...clone(binding)});state.status='confirmed';state.receipt={kind:'VIRTUAL_DECISION'};return clone(state);
    },
    reset(){operations.push({type:'reset'});state.current=null;state.revision++;state.status='idle';next=0;rendered=null;return clone(state);},
  };
  if(options.recommended)decision.recommend();
  if(options.status){state.status=options.status;state.current=null;}
  if(options.uncertainties)state.uncertainties=options.uncertainties;
  const app = {
    // These page-isolation cases start after onboarding; real gate behavior has its own App integration suite.
    ensureTasteProfile() { return true; },
    syncPage(page){page.setData({themeClass:'theme-dark'});},
    async checkService(){operations.push({type:'checkService'});if(options.checkService)return options.checkService(old);old.state.status='ready';},
    async acceptConsent(){operations.push({type:'acceptConsent'});old.state.consent=true;old.state.status='ready';},
  };
  const platform = new Proxy({}, {get(_target,key){
    if(/Storage|request|getLocation|chooseLocation|openLocation|makePhoneCall|setClipboardData|login/i.test(String(key)))return ()=>{throw new Error(`Forbidden virtual page API: ${String(key)}`);};
    return value=>calls.push({type:key,value});
  }});
  let presenter;
  function loadPresenter() {
    if (presenter) return presenter;
    const filename = path.join(__dirname, '../lib/decision/result-presenter.js');
    const module = { exports: {} };
    new vm.Script(`(function(require,module,exports){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename }).runInContext(context)(id => {
      if (id === './service') return decision;
      throw new Error(`Unexpected presenter module ${id}`);
    }, module, module.exports);
    presenter = module.exports;
    return presenter;
  }
  const context = vm.createContext({
    require(id){if(id==='../../lib/decision/service')return decision;if(id==='../../lib/decision/result-presenter')return loadPresenter();if(id==='../../lib/service')return old;if(id==='../../lib/home-title')return require('../lib/home-title');throw new Error(`Unexpected module ${id}`);},
    setTimeout() { return 1; }, clearTimeout() {},
    Page(value){definition=value;},wx:platform,getApp:()=>app,getCurrentPages:()=>[{route:'pages/index/index'}],
  });
  new vm.Script(fs.readFileSync(path.join(__dirname,'..','pages',name,'index.js'),'utf8')).runInContext(context);
  const page={...definition,data:clone(definition.data),setData(update,callback){Object.assign(this.data,clone(update));if(callback){if(options.deferRender)callbacks.push(callback);else callback();}}};
  if(page.onLoad)page.onLoad(options.route||{id:state.current?state.current.id:'virtual-0',revision:String(state.revision)});
  const binding=()=>({id:page.data.current?.id,revision:page.data.current?.revision});
  return {page,state,old,decision,operations,calls,callbacks,binding,app};
}
function noSensitive(page){assert.equal(/latitude|longitude|resultToken|accessToken|must-not-render/.test(JSON.stringify(page.data)),false);}
function count(h,type){return h.operations.filter(item=>item.type===type).length;}

test('virtual home starts without consent, config, city lookup or account calls',()=>{
  const h=harness('index');h.page.onShow();h.page.decide();
  assert.equal(h.page.data.city,'虚拟广场');assert.equal(h.page.data.target,'PACKAGE');
  assert.equal(h.page.data.decisionOpen,true);
  assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
  assert.equal(h.operations.length,0);noSensitive(h.page);
});
test('home virtual routes do not ask for online privacy consent',async()=>{
  const h=harness('index');h.page.onShow();
  await h.page.open(event({page:'conditions'}));await h.page.open(event({page:'location'}));
  assert.deepEqual(h.calls.filter(call=>call.type==='navigateTo').map(call=>call.value.url),['/pages/conditions/index','/pages/location/index']);
  assert.equal(count(h,'checkService'),0);
});
test('home account navigation preserves explicit consent and reconnects after acceptance',async()=>{
  const h=harness('index');h.page.onShow();await h.page.open(event({page:'account'}));
  assert.equal(h.page.data.tab,2);assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
  h.old.state.consent=true;await h.page.open(event({page:'account'}));
  assert.equal(count(h,'checkService'),1);assert.equal(h.calls.at(-1).value.url,'/pages/account/index');
});
test('late account reconnection cannot navigate after home leaves',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const h=harness('index',{checkService:()=>pending});h.old.state.consent=true;h.page.onShow();
  const opening=h.page.open(event({page:'account'}));h.page.onHide();h.old.state.status='ready';finish();await opening;
  assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
});
test('failed account connection stays recoverable and does not block virtual decision',async()=>{
  const h=harness('index',{checkService:async()=>{}});h.old.state.consent=true;h.page.onShow();await h.page.open(event({page:'account'}));
  assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);h.page.decide();assert.equal(h.page.data.decisionOpen,true);
  assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
});
test('home closes an in-place decision on dismissal, target changes and lifecycle exit',()=>{
  const h=harness('index');h.page.onShow();h.page.decide();
  assert.equal(h.page.data.decisionOpen,true);
  h.page.closeDecision();assert.equal(h.page.data.decisionOpen,false);
  h.page.decide();h.page.selectTarget(event({target:'RESTAURANT'}));
  assert.equal(h.page.data.decisionOpen,false);assert.equal(h.state.target,'RESTAURANT');
  h.page.decide();h.page.onHide();assert.equal(h.page.data.decisionOpen,false);
  h.page.decide();assert.equal(h.page.data.decisionOpen,false);
  h.page.onShow();h.page.decide();h.page.onUnload();assert.equal(h.page.data.decisionOpen,false);
  assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
});
test('home without a virtual origin keeps the existing map navigation path',()=>{
  const h=harness('index');h.state.origin=null;h.page.onShow();h.page.decide();
  assert.equal(h.page.data.decisionOpen,false);
  assert.equal(h.calls.at(-1).value.url,'/pages/location/index');
  assert.equal(count(h,'recommend'),0);
});
test('all virtual pages initialize without real-service consent and expose lifecycle synchronization',()=>{
  for(const name of ['conditions','location','results','detail']){
    const h=harness(name,{recommended:name==='detail'});h.page.onShow();
    assert.equal(typeof h.page.syncState,'function');assert.equal(h.page.data.themeClass,'theme-dark');
    assert.equal(h.calls.some(call=>call.type==='reLaunch'),false);noSensitive(h.page);
  }
});
test('virtual location mount and selection never request device location or search a provider',()=>{
  const h=harness('location');h.page.onShow();
  h.page.choose(event({id:'library'}));h.page.confirm();
  assert.deepEqual(h.state.origin,{x:250,y:300,label:'云朵书店'});
  assert.equal(h.calls.at(-1).value.url,'/pages/results/index');
  assert.equal(count(h,'configure'),1);noSensitive(h.page);
});
test('virtual location rejects invalid identifiers and coordinates outside 0 to 1000',()=>{
  const h=harness('location');h.page.onShow();const before=clone(h.page.data.origin);
  h.page.choose(event({id:'unregistered-place'}));
  for(const value of [-1,1001,NaN,2.5])h.page.coordinate({currentTarget:{dataset:{key:'x'}},detail:{value}});
  assert.deepEqual(h.page.data.origin,before);assert.equal(count(h,'configure'),0);
});
test('virtual coordinates include boundary values and stale hidden actions do not commit',()=>{
  const h=harness('location');h.page.onShow();
  h.page.coordinate({currentTarget:{dataset:{key:'x'}},detail:{value:0}});
  h.page.coordinate({currentTarget:{dataset:{key:'y'}},detail:{value:1000}});
  assert.equal(h.page.data.x,0);assert.equal(h.page.data.y,1000);
  h.page.onHide();h.page.confirm();assert.equal(count(h,'configure'),0);
});
test('conditions keep a draft across theme refresh and virtual map round trips',()=>{
  const h=harness('conditions');h.page.onShow();h.page.select(event({key:'budgetCents',index:2}));h.page.syncState();h.page.onHide();h.page.onShow();
  assert.equal(h.page.data.choices.budgetCents.find(item=>item.selected).value,3000);
  assert.equal(h.state.options.budgetCents,null);
  h.page.submit();assert.equal(h.state.options.budgetCents,3000);assert.equal(h.state.strategy,'explicit');
});
test('condition handlers reject forged keys, options and out-of-range priorities',()=>{
  const h=harness('conditions');h.page.onShow();
  h.page.select(event({key:'providerSecret',index:0}));h.page.select(event({key:'budgetCents',index:99}));
  h.page.priority({currentTarget:{dataset:{key:'price'}},detail:{value:7}});
  h.page.priority({currentTarget:{dataset:{key:'secret'}},detail:{value:1}});
  assert.equal(h.page.data.choices.budgetCents.find(item=>item.selected).value,null);
  assert.equal(h.page.data.priorities.find(item=>item.key==='price').value,1);assert.equal(count(h,'configure'),0);
});
test('condition priority and dietary toggles are explicit and applied only on submit',()=>{
  const h=harness('conditions');h.page.onShow();
  h.page.toggle({currentTarget:{dataset:{key:'vegetarianOnly'}},detail:{value:true}});
  h.page.priority({currentTarget:{dataset:{key:'price'}},detail:{value:3}});
  assert.equal(h.state.options.vegetarianOnly,false);h.page.submit();
  assert.equal(h.state.options.vegetarianOnly,true);assert.equal(h.state.options.weights.price,3);
});
test('missing virtual origin leads from conditions to virtual location without recommendation',()=>{
  const h=harness('conditions');h.state.origin=null;h.page.onShow();h.page.submit();
  assert.equal(h.calls.at(-1).value.url,'/pages/location/index');assert.equal(count(h,'recommend'),0);
});
test('results initialize exactly one current card and do not auto-reroll on show or sync',()=>{
  const h=harness('results');h.page.onShow();const id=h.page.data.current.id;
  h.page.syncState();h.page.onHide();h.page.onShow();
  assert.equal(count(h,'recommend'),1);assert.equal(h.page.data.current.id,id);
  assert.equal(h.page.data.items,undefined);assert.equal(count(h,'confirm'),0);noSensitive(h.page);
});
test('render evidence is reported only after the native setData callback',()=>{
  const h=harness('results',{deferRender:true});h.page.onShow();
  assert.equal(count(h,'render'),0);h.page.confirm(event(h.binding()));assert.equal(count(h,'confirm'),0);
  h.callbacks.splice(0).forEach(callback=>{callback();});assert.equal(count(h,'render'),1);
  h.page.confirm(event(h.binding()));assert.equal(count(h,'confirm'),1);
});
test('old render callbacks cannot mark a replacement card or a hidden page',()=>{
  const h=harness('results',{deferRender:true});h.page.onShow();const first=h.callbacks.splice(0);
  h.decision.configure({target:'RESTAURANT'});h.page.load(false);first.forEach(callback=>{callback();});
  assert.equal(count(h,'render'),0);h.page.onHide();h.callbacks.splice(0).forEach(callback=>{callback();});assert.equal(count(h,'render'),0);
});
test('confirm targets the currently rendered id and revision, not a stale tap',()=>{
  const h=harness('results');h.page.onShow();const stale=h.binding();h.page.next(event(stale));
  h.page.confirm(event(stale));assert.equal(count(h,'confirm'),0);
  h.page.confirm(event(h.binding()));assert.equal(count(h,'confirm'),1);assert.equal(h.page.data.confirmed,true);
});
test('repeated confirmation cannot become a second event or an eaten record',()=>{
  const h=harness('results');h.page.onShow();const binding=h.binding();h.page.confirm(event(binding));h.page.confirm(event(binding));
  assert.equal(count(h,'confirm'),1);assert.deepEqual(h.state.receipt,{kind:'VIRTUAL_DECISION'});assert.equal(h.state.receipt.eaten,undefined);
});
test('swap advances one card and exhaustion stops without automatic refill',()=>{
  const h=harness('results');h.page.onShow();const first=h.binding();h.page.next(event(first));assert.notEqual(h.page.data.current.id,first.id);
  h.page.next(event(h.binding()));assert.equal(h.page.data.status,'exhausted');assert.equal(h.page.data.current,null);
  const before=count(h,'recommend');h.page.syncState();h.page.onHide();h.page.onShow();assert.equal(count(h,'recommend'),before);
});
test('hidden result handlers do not recommend, confirm, reset or navigate',()=>{
  const h=harness('results');h.page.onShow();const binding=h.binding();h.page.onHide();const before=clone(h.operations);
  h.page.next(event(binding));h.page.confirm(event(binding));h.page.detail(event(binding));h.page.restart();h.page.adjust();
  assert.deepEqual(h.operations,before);assert.equal(h.calls.some(call=>call.type==='navigateTo'),false);
});
test('strategy changes occur only on explicit valid random or exploration controls',()=>{
  const h=harness('results');h.page.onShow();assert.equal(count(h,'configure'),0);
  h.page.chooseStrategy(event({strategy:'linucb'}));assert.equal(count(h,'configure'),0);
  h.page.chooseStrategy(event({strategy:'uniform'}));assert.equal(h.state.strategy,'uniform');assert.equal(h.operations.filter(item=>item.type==='recommend').at(-1).reroll,true);
  h.page.chooseStrategy(event({strategy:'weighted'}));assert.equal(h.state.strategy,'weighted');
});
test('unknown information, no feasible result and exhaustion remain separate states',()=>{
  for(const status of ['needs_information','no_feasible_candidate','exhausted']){
    const h=harness('results',{status,uncertainties:['价格未知']});h.page.onShow();
    assert.equal(h.page.data.status,status);assert.equal(h.page.data.current,null);assert.equal(h.page.data.uncertainties[0],'价格未知');
    assert.equal(count(h,'recommend'),0);assert.equal(count(h,'render'),0);
  }
});
test('decision errors clear the current card and cannot preserve a confirmable binding',()=>{
  const h=harness('results',{recommendError:true});h.page.onShow();
  assert.equal(h.page.data.current,null);assert.equal(h.page.data.error,'合成决策错误');h.page.confirm();assert.equal(count(h,'confirm'),0);
  assert.equal(h.page.data.confirmed,false);
});
test('a rejected confirmation keeps the shared presenter out of its success state',()=>{
  const h=harness('results',{confirmError:true});h.page.onShow();h.page.confirm(event(h.binding()));
  assert.equal(h.page.data.status,'recommended');assert.equal(h.page.data.confirmed,false);
  assert.equal(h.page.data.error,'合成确认错误');assert.equal(count(h,'confirm'),0);
});
test('detail links carry candidate identity and revision, never a positional list index',()=>{
  const h=harness('results');h.page.onShow();h.page.detail(event(h.binding()));
  assert.equal(h.calls.at(-1).value.url,'/pages/detail/index?id=virtual-0&revision=1');
});
test('detail accepts only the current candidate and rejects replacement revisions',()=>{
  const h=harness('detail',{recommended:true});h.page.onShow();assert.equal(h.page.data.current,true);noSensitive(h.page);
  h.decision.recommend({reroll:true});h.page.syncState();h.page.confirm();
  assert.equal(h.page.data.result,null);assert.equal(h.page.data.current,false);assert.equal(count(h,'confirm'),0);
});
test('detail rejects malformed revision and unrelated candidate identifiers',()=>{
  for(const route of [{id:'virtual-0',revision:'1x'},{id:'wrong',revision:'1'},{id:'virtual-0',revision:'0'}]){
    const h=harness('detail',{recommended:true,route});h.page.onShow();h.page.confirm();assert.equal(h.page.data.current,false);assert.equal(count(h,'confirm'),0);
  }
});
test('detail confirm requires completed rendering and ignores callbacks after leaving',()=>{
  const h=harness('detail',{recommended:true,deferRender:true});h.page.onShow();h.page.confirm();assert.equal(count(h,'confirm'),0);
  h.page.onHide();h.callbacks.splice(0).forEach(callback=>{callback();});assert.equal(count(h,'render'),0);
  h.page.onShow();h.callbacks.splice(0).forEach(callback=>{callback();});h.page.confirm();assert.equal(count(h,'confirm'),1);
});
test('detail exposes no real-place operations, persistence or private-feedback actions',()=>{
  const h=harness('detail',{recommended:true});h.page.onShow();h.page.confirm();
  for(const method of ['navigate','call','copyAddress','saveFavorite','feedback','persist'])assert.equal(h.page[method],undefined);
  assert.equal(h.calls.some(call=>['openLocation','makePhoneCall','setClipboardData','request'].includes(call.type)),false);
});
test('all virtual templates keep sharing closed, bind real handlers and render one result card',()=>{
  for(const name of ['index','conditions','location','results','detail']){
    const h=harness(name,{recommended:name==='detail'});h.page.onShow();
    const template=fs.readFileSync(path.join(__dirname,'..','pages',name,'index.wxml'),'utf8');
    for(const match of template.matchAll(/(?:bindtap|catchtap|bindchange)="([A-Za-z]+)"/g))assert.equal(typeof h.page[match[1]],'function',`${name}.${match[1]}`);
    assert.equal(/open-type\s*=\s*["']share["']/.test(template),false);
    assert.equal(h.page.onShareAppMessage,undefined);assert.equal(h.page.onShareTimeline,undefined);
    if(name!=='index')assert.equal(h.calls.some(call=>call.type==='hideShareMenu'),true);
  }
  const result=fs.readFileSync(path.join(__dirname,'../pages/results/index.wxml'),'utf8');
  assert.equal((result.match(/class="single-result"/g)||[]).length,1);
  assert.equal(/wx:for="{{(?:items|results|candidates)}}"/.test(result),false);
});
