const decision = require('../../lib/decision/service');
const OPTIONS = {
  budgetCents: [{value:null,label:'不限'},{value:2000,label:'20 元内'},{value:3000,label:'30 元内'},{value:4000,label:'40 元内'}],
  maxDistanceUnits: [{value:null,label:'不限'},{value:150,label:'150 单位内'},{value:300,label:'300 单位内'},{value:600,label:'600 单位内'}],
  maxSpicy: [{value:null,label:'都可以'},{value:0,label:'不辣'},{value:1,label:'微辣以内'}],
};
function copy(value) { return JSON.parse(JSON.stringify(value)); }
Page({
  data:{themeClass:'',preferenceReady:false,target:'PACKAGE',choices:{},vegetarianOnly:false,preferMain:true,priorities:[],locationLabel:'',summary:'',error:''},
  onLoad(){this._draft=null;},
  onShow(){this._active=getApp().ensureTasteProfile();this.setData({preferenceReady:this._active});if(!this._active)return;getApp().syncPage(this);if(!this._draft)this._draft=copy(decision.getState().options);this.syncState();wx.hideShareMenu();},
  onHide(){this._active=false;},
  onUnload(){this._active=false;this._draft=null;},
  syncState(){
    const state=decision.getState(), draft=this._draft||copy(state.options);
    this._draft=draft;
    const choices={};
    Object.keys(OPTIONS).forEach(key=>{choices[key]=OPTIONS[key].map((option,index)=>({...option,index,selected:draft[key]===option.value}));});
    const weights=draft.weights||{price:1,distance:1,main:1};
    this.setData({target:state.target,choices,vegetarianOnly:draft.vegetarianOnly===true,preferMain:draft.preferMain===true,
      priorities:[['price','更在意价格'],['distance','更在意距离'],['main','更在意模拟正餐']].filter(([key])=>key!=='main'||state.target==='PACKAGE').map(([key,label])=>({key,label,value:weights[key]})),
      locationLabel:state.origin?state.origin.label:'还未选择虚拟地点',summary:state.summary||''});
  },
  select(event){
    const key=event.currentTarget.dataset.key,index=Number(event.currentTarget.dataset.index);
    if(!this._active||!Number.isInteger(index)||!OPTIONS[key]?.[index])return;
    this._draft[key]=OPTIONS[key][index].value;this.setData({error:''});this.syncState();
  },
  target(event){
    if(!this._active)return;
    const target=event.currentTarget.dataset.target;if(!['PACKAGE','RESTAURANT'].includes(target))return;
    decision.configure({target});this.syncState();
  },
  toggle(event){
    const key=event.currentTarget.dataset.key;if(!this._active||!['vegetarianOnly','preferMain'].includes(key))return;
    this._draft[key]=event.detail.value===true;this.syncState();
  },
  priority(event){
    const key=event.currentTarget.dataset.key,value=Number(event.detail.value);
    if(!this._active||!['price','distance','main'].includes(key)||!Number.isInteger(value)||value<0||value>6)return;
    this._draft.weights={...(this._draft.weights||{price:1,distance:1,main:1}),[key]:value};this.syncState();
  },
  location(){if(this._active)wx.navigateTo({url:'/pages/location/index'});},
  submit(){
    if(!this._active||!getApp().ensureTasteProfile())return;
    try{
      decision.configure({options:copy(this._draft),strategy:'explicit'});
      if(!decision.getState().origin)return this.location();
      wx.navigateTo({url:'/pages/results/index'});
    }catch(error){this.setData({error:error.message||'请检查这顿的条件。'});}
  }
});
