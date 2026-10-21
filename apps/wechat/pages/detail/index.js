const decision = require('../../lib/decision/service');
function lines(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.text||'').filter(Boolean):[];}
Page({
  data:{themeClass:'',preferenceReady:false,current:false,result:null,confirmed:false,error:'',notice:'本次选择已变化，请返回重新决定。'},
  onLoad(options){
    this._generation=0;this._rendered=false;
    this._id=typeof options.id==='string'?options.id:'';
    this._revision=/^\d+$/.test(String(options.revision||''))?Number(options.revision):-1;
  },
  onShow(){this._active=getApp().ensureTasteProfile();this.setData({preferenceReady:this._active});if(!this._active)return;getApp().syncPage(this);wx.hideShareMenu();this.syncState();},
  onHide(){this._active=false;this._generation+=1;this._rendered=false;},
  onUnload(){this._active=false;this._generation+=1;this._rendered=false;this._id='';},
  syncState(){
    const result=decision.resolve(this._id,this._revision),generation=++this._generation;this._rendered=false;
    if(!result)return this.setData({current:false,result:null,confirmed:false,error:'',notice:'本次选择已变化，请返回重新决定。'});
    this.setData({current:true,confirmed:decision.getState().status==='confirmed',result:{name:result.name,restaurantName:result.restaurantName||'',mealName:result.mealName||'',priceText:result.priceText||'价格未知',distanceText:result.distanceText||'虚拟距离未知',roleText:result.roleText||'',factsSummary:lines(result.factsSummary),reasons:lines(result.reasons),uncertainties:lines(result.uncertainties)},notice:''},()=>{
      if(!this._active||generation!==this._generation||!decision.resolve(this._id,this._revision))return;
      decision.markRendered({candidateId:this._id,revision:this._revision});this._rendered=true;
    });
  },
  confirm(){
    if(!this._active||!this._rendered||!decision.resolve(this._id,this._revision)||decision.getState().status!=='recommended')return;
    try{decision.confirm({candidateId:this._id,revision:this._revision});this.syncState();}
    catch(error){this.setData({error:error.message||'这份选择已变化，请重新决定。'});this.syncState();}
  },
  back(){if(!this._active)return;if(getCurrentPages().length>1)wx.navigateBack();else wx.redirectTo({url:'/pages/results/index'});}
});
