using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Printing;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Windows.Forms;

internal sealed class Setup:Form {
    readonly ComboBox queues=new ComboBox{Dock=DockStyle.Top,DropDownStyle=ComboBoxStyle.DropDownList};
    readonly TextBox code=new TextBox{Dock=DockStyle.Top,UseSystemPasswordChar=true};
    readonly Button install=new Button{Text="绑定并启动",AutoSize=true};
    readonly ErrorProvider errors=new ErrorProvider{BlinkStyle=ErrorBlinkStyle.NeverBlink};
    readonly Label status=new Label{AutoSize=true,MaximumSize=new Size(430,0)};
    static readonly string Folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"PMS","ReceiptPrinter");
    static readonly string Installed=Path.Combine(Folder,"PmsReceiptPrinter.exe");
    public Setup(){
        Text="PMS 公寓小票打印助手";ClientSize=new Size(470,310);Font=new Font("Microsoft YaHei UI",10);
        var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(20),ColumnCount=1,AutoScroll=true};
        Controls.Add(layout);
        foreach(string p in PrinterSettings.InstalledPrinters)queues.Items.Add(p);
        for(int i=0;i<queues.Items.Count;i++)if(queues.Items[i].ToString().IndexOf("XP-80",StringComparison.OrdinalIgnoreCase)>=0){queues.SelectedIndex=i;break;}
        layout.Controls.Add(new Label{Text="本机小票打印机（XP-80C）",AutoSize=true});layout.Controls.Add(queues);
        layout.Controls.Add(new Label{Text="系统与设备中生成的一次性绑定码",AutoSize=true});layout.Controls.Add(code);
        layout.Controls.Add(install);layout.Controls.Add(status);
        if(File.Exists(ReceiptService.Config)){
            try{status.Text="已绑定 "+ReceiptService.LoadBinding().queue;}catch{status.Text="无法读取本机绑定";}
        }
        if(File.Exists(ReceiptService.Halt) && File.ReadAllText(ReceiptService.Halt)=="rebind") status.Text="绑定已失效，请使用新的绑定码";
        else if(File.Exists(ReceiptService.Halt)){
            var resume=new Button{Text="已核对出纸，恢复接收新任务",AutoSize=true};
            layout.Controls.Add(resume);resume.Click+=(s,e)=>{if(MessageBox.Show("已核对打印队列和纸张？原任务不会重新发送。","恢复打印",MessageBoxButtons.YesNo)==DialogResult.Yes){File.Delete(ReceiptService.Halt);resume.Enabled=false;status.Text="已恢复";}};
        }
        install.Click+=(s,e)=>Bind();
    }
    static void Sc(string args){
        var start=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"sc.exe"),args){UseShellExecute=false,CreateNoWindow=true};
        using(var p=Process.Start(start)){if(!p.WaitForExit(15000)||p.ExitCode!=0)throw new InvalidOperationException("Windows 服务设置失败");}
    }
    static ServiceController Existing(){
        foreach(var s in ServiceController.GetServices()){if(s.ServiceName==ReceiptService.NameId)return s;s.Dispose();}return null;
    }
    async void Bind(){
        string queue=queues.SelectedItem as string, key=code.Text.Trim();
        errors.Clear();
        if(queue==null)errors.SetError(queues,"请选择本机 XP-80C 打印队列");
        if(key.Length!=43)errors.SetError(code,"请输入完整的一次性绑定码");
        if(queue==null||key.Length!=43){
            status.Text=queue==null?"请选择打印机":"请输入完整的一次性绑定码";
            if(queue==null)queues.Focus();else code.Focus();
            return;
        }
        if(File.Exists(ReceiptService.Config)&&MessageBox.Show("替换此电脑当前的打印绑定？","重新绑定",MessageBoxButtons.YesNo)!=DialogResult.Yes)return;
        install.Enabled=false;status.Text="正在绑定";
        try{
            await System.Threading.Tasks.Task.Run(()=>{
                Directory.CreateDirectory(Folder);Directory.CreateDirectory(ReceiptService.Root);
                var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
                foreach(var sid in new[]{WellKnownSidType.LocalSystemSid,WellKnownSidType.BuiltinAdministratorsSid,WellKnownSidType.LocalServiceSid}){
                    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid,null),sid==WellKnownSidType.LocalServiceSid?FileSystemRights.Modify:FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
                }
                Directory.SetAccessControl(ReceiptService.Root,acl);
                var reply=ReceiptService.Post("bind",key,new {queue=queue});
                if(reply==null||String.IsNullOrEmpty(reply.token))throw new InvalidDataException("未收到服务凭据");
                using(var current=Existing()){
                    if(current!=null&&current.Status!=ServiceControllerStatus.Stopped){current.Stop();current.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(30));}
                    ReceiptService.SaveBinding(new ReceiptService.Binding{token=reply.token,queue=queue});
                    if(!String.Equals(Application.ExecutablePath,Installed,StringComparison.OrdinalIgnoreCase))File.Copy(Application.ExecutablePath,Installed,true);
                    if(current==null)Sc("create "+ReceiptService.NameId+" binPath= \"\\\""+Installed+"\\\" --service\" start= auto obj= \"NT AUTHORITY\\LocalService\"");
                    if(File.Exists(ReceiptService.Halt))File.Delete(ReceiptService.Halt);
                    using(var service=new ServiceController(ReceiptService.NameId)){service.Start();service.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(20));}
                }
            });
            code.Clear();status.Text="已绑定 "+queue+"，服务随 Windows 启动";
        }catch(Exception ex){status.Text="绑定或安装失败："+ex.Message+"。如绑定码已使用，请在 PMS 重新生成。";}
        finally{install.Enabled=true;}
    }
}
