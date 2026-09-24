import { finance, type FinanceEntry, type FinanceProject } from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }
let hold: HoldToTalk | null = null;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

Page({
  data: {
    loading: true, saving: false, showForm: false,
    hasSpeech: false, recording: false, pressing: false,
    entries: [] as Array<FinanceEntry & { amountText:string; flowText:string; flowClass:string; reimbursementText:string }>,
    projects: [] as FinanceProject[],
    projectOptions: ['暂不选择项目'] as string[],
    selectedProjectName: '暂不选择项目',
    form: { businessDate: today(), flowType:'expense', owner:'pruis', reason:'', amount:'', paymentMethod:'wechat', projectId:null as number|null, reimbursementRequired:true },
  },
  onLoad(){ this.bindSpeech(); this.load(); },
  onPullDownRefresh(){ this.load().finally(()=>wx.stopPullDownRefresh()); },
  async load(){
    this.setData({loading:true});
    try{
      const [entries,projects]=await Promise.all([finance.entries(),finance.projects()]);
      this.setData({
        projects,
        projectOptions:['暂不选择项目',...projects.map(p=>p.name)],
        entries:entries.slice(0,80).map(e=>({...e,amountText:Number(e.amount).toFixed(2),flowText:e.flowType==='income'?'收入':'支出',flowClass:e.flowType==='income'?'income':'expense',reimbursementText:e.reimbursementStatus==='pending'?'待报销':e.reimbursementStatus==='reimbursed'?'已报销':'无需报销'})),
      });
    }catch(e:any){wx.showToast({icon:'none',title:e?.message||'加载失败，请稍后重试'});}
    finally{this.setData({loading:false});}
  },
  openForm(){this.setData({showForm:true});}, closeForm(){if(!this.data.saving)this.setData({showForm:false});},
  bindSpeech(){
    if(!speechManager)return;
    hold=createHoldToTalk(speechManager,{onPressing:(pressing)=>this.setData({pressing})});
    this.setData({hasSpeech:true});
    speechManager.onStart=()=>{this.setData({recording:true});hold?.started();};
    speechManager.onRecognize=()=>undefined;
    speechManager.onStop=(res:{result?:string})=>{hold?.ended();const text=String(res.result||'').trim();const before=this.data.form.reason.trim();this.setData({recording:false,'form.reason':text?(before?`${before}；${text}`:text):before});};
    speechManager.onError=(err:any)=>{hold?.ended();this.setData({recording:false});speechErrorTip(err).then((title)=>wx.showToast({icon:'none',title}));};
  },
  onStartRecord(){hold?.press();}, onStopRecord(){hold?.release();}, onHoldMove(){},
  setFlow(e:any){this.setData({'form.flowType':e.currentTarget.dataset.value});},
  setOwner(e:any){this.setData({'form.owner':e.currentTarget.dataset.value});},
  setPayment(e:any){this.setData({'form.paymentMethod':e.currentTarget.dataset.value});},
  onDate(e:any){this.setData({'form.businessDate':e.detail.value});},
  onReason(e:any){this.setData({'form.reason':e.detail.value});},
  onAmount(e:any){this.setData({'form.amount':e.detail.value});},
  onProject(e:any){const index=Number(e.detail.value);this.setData({'form.projectId':index?this.data.projects[index-1].id:null,selectedProjectName:this.data.projectOptions[index]});},
  onReimbursement(e:any){this.setData({'form.reimbursementRequired':e.detail.value});},
  noop(){},
  async save(){
    const form=this.data.form;
    if(!form.reason.trim()){wx.showToast({icon:'none',title:'请填写事由'});return;}
    if(!Number(form.amount)||Number(form.amount)<=0){wx.showToast({icon:'none',title:'请填写正确金额'});return;}
    this.setData({saving:true});
    try{await finance.createEntry(form as any);wx.showToast({icon:'success',title:'已记账'});this.setData({showForm:false,form:{...form,reason:'',amount:'',projectId:null}});await this.load();}
    catch(e:any){wx.showToast({icon:'none',title:e?.message||'保存失败，请重试'});}
    finally{this.setData({saving:false});}
  },
});
