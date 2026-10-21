const decision = require('../../lib/decision/service');
const PLACES = [
  {id:'square',label:'虚拟广场',x:500,y:500},
  {id:'library',label:'云朵书店',x:250,y:300},
  {id:'garden',label:'向阳花园',x:750,y:250},
  {id:'station',label:'梧桐街口',x:320,y:780},
  {id:'campus',label:'晴天校园',x:780,y:720},
];
function valid(value){return Number.isFinite(value)&&value>=0&&value<=1000;}
Page({
  data:{themeClass:'',preferenceReady:false,places:[],origin:null,x:500,y:500,label:'虚拟广场',error:''},
  onLoad(){this._draft=null;},
  onShow(){
    this._active=getApp().ensureTasteProfile();this.setData({preferenceReady:this._active});if(!this._active)return;
    this._active=true;getApp().syncPage(this);wx.hideShareMenu();
    if(!this._draft){const origin=decision.getState().origin;this._draft=origin?{...origin}:{...PLACES[0]};}
    this.syncState();
  },
  onHide(){this._active=false;},
  onUnload(){this._active=false;this._draft=null;},
  syncState(){
    const origin=this._draft||decision.getState().origin||PLACES[0];
    this.setData({origin:{x:origin.x,y:origin.y,label:origin.label},x:origin.x,y:origin.y,label:origin.label,
      places:PLACES.map(place=>({...place,left:place.x/10,top:place.y/10,selected:place.x===origin.x&&place.y===origin.y}))});
  },
  choose(event){
    if(!this._active)return;const place=PLACES.find(item=>item.id===event.currentTarget.dataset.id);if(!place)return;
    this._draft={x:place.x,y:place.y,label:place.label};this.setData({error:''});this.syncState();
  },
  coordinate(event){
    const key=event.currentTarget.dataset.key,value=Number(event.detail.value);
    if(!this._active||!['x','y'].includes(key)||!Number.isInteger(value)||!valid(value))return;
    this._draft={...this._draft,[key]:value,label:'自选虚拟地点'};this.setData({error:''});this.syncState();
  },
  confirm(){
    if(!this._active||!getApp().ensureTasteProfile()||!this._draft||!valid(this._draft.x)||!valid(this._draft.y))return;
    try{decision.configure({origin:{x:this._draft.x,y:this._draft.y,label:this._draft.label}});
      if(getCurrentPages().length>1)wx.navigateBack();else wx.redirectTo({url:'/pages/results/index'});
    }catch(error){this.setData({error:error.message||'虚拟地点无法使用，请重新选择。'});}
  }
});
