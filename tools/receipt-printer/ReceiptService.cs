using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
internal sealed class ReceiptService : ServiceBase {
    internal const string NameId="PmsReceiptPrinter";
    internal static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"PMS","ReceiptPrinter","State");
    internal static readonly string Config=Path.Combine(Root,"binding.dat");
    internal static readonly string Halt=Path.Combine(Root,"check-paper");

    readonly ManualResetEvent stop=new ManualResetEvent(false);
    Thread worker;
    internal class Binding {public string token;public string queue;}
    internal class Job {public int id;public string[] lines;}
    internal class Reply {public string token;public Job job;}
    internal static Reply Post(string route,string token,object body) {
        var json=new JavaScriptSerializer{MaxJsonLength=16384};
        var req=(HttpWebRequest)WebRequest.Create("https://prsznh.cn/api/v1/receipt-print-agent/"+route);
        req.AllowAutoRedirect=false;req.Timeout=8000;req.ReadWriteTimeout=8000;req.Method="POST";
        req.ContentType="application/json";req.Headers["Authorization"]="Bearer "+token;
        byte[] data=Encoding.UTF8.GetBytes(json.Serialize(body));
        using(var s=req.GetRequestStream())s.Write(data,0,data.Length);
        using(var res=(HttpWebResponse)req.GetResponse()){
            if((int)res.StatusCode<200||(int)res.StatusCode>=300)throw new InvalidDataException("服务器未确认请求");
            using(var r=new StreamReader(res.GetResponseStream()))return json.Deserialize<Reply>(r.ReadToEnd());
        }
    }
    internal static void Store(string path,byte[] data){
        string temp=path+".new";
        using(var f=new FileStream(temp,FileMode.Create,FileAccess.Write,FileShare.None)){f.Write(data,0,data.Length);f.Flush(true);}
        if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);
    }
    internal static void SaveBinding(Binding b){
        var bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(b));
        Store(Config,ProtectedData.Protect(bytes,null,DataProtectionScope.LocalMachine));
    }
    internal static Binding LoadBinding(){
        var data=ProtectedData.Unprotect(File.ReadAllBytes(Config),null,DataProtectionScope.LocalMachine);
        return new JavaScriptSerializer().Deserialize<Binding>(Encoding.UTF8.GetString(data));
    }
    internal static void Reserve(string stateDirectory,int id,DateTime utc) {
        string mark=Path.Combine(stateDirectory,"last-task"), rate=Path.Combine(stateDirectory,"recent-tasks");
        int previous=File.Exists(mark)?Int32.Parse(File.ReadAllText(mark)):0;
        if(id<=previous)throw new InvalidDataException("重复任务");
        var recent=File.Exists(rate)?File.ReadAllLines(rate).Select(Int64.Parse).Where(t=>t>=utc.AddMinutes(-1).Ticks).ToList():new List<long>();
        if(recent.Count>=6)throw new InvalidOperationException("连续打印过多，请核对出纸");
        recent.Add(utc.Ticks);
        Store(rate,Encoding.ASCII.GetBytes(String.Join("\n",recent)));
        Store(mark,Encoding.ASCII.GetBytes(id.ToString()));
    }
    public ReceiptService(){ServiceName=NameId;}
    protected override void OnStart(string[] args){worker=new Thread(RunLoop){IsBackground=true};worker.Start();}
    protected override void OnStop(){stop.Set();if(worker!=null) worker.Join(18000);}
    void RunLoop(){
        while(!stop.WaitOne(0)){
            try {
                if(File.Exists(Halt)){stop.WaitOne(5000);continue;}
                var b=LoadBinding();
                if(!RollPrinter.Ready(b.queue)){stop.WaitOne(5000);continue;}
                var job=Post("next",b.token,new {}).job;
                if(job!=null){
                    try {
                        Reserve(Root,job.id,DateTime.UtcNow);
                        RollPrinter.Print(b.queue,job.id,job.lines);
                    } catch {
                        Store(Halt,Encoding.ASCII.GetBytes(job.id.ToString()));
                        Post("report",b.token,new {id=job.id,state="unknown"});throw;
                    }
                    // A lost acknowledgement never causes another spool submission.
                    Post("report",b.token,new {id=job.id,state="spooled"});
                }
            } catch(WebException ex){
                using(var response=ex.Response as HttpWebResponse){
                    if(response!=null && (response.StatusCode==HttpStatusCode.Unauthorized || response.StatusCode==HttpStatusCode.Forbidden))
                        Store(Halt,Encoding.ASCII.GetBytes("rebind"));
                }
                stop.WaitOne(5000);
            } catch {stop.WaitOne(5000);}
            stop.WaitOne(3000);
        }
    }
    [STAThread] static int Main(string[] args){
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        if(args.Contains("--self-test")){
            var bytes=RollPrinter.Encode(new[]{"合成小票","合计 23.00"});
            if(bytes.Last()!=0||bytes.Count(x=>x==10)!=2)return 1;
            foreach(var invalid in new[]{new[]{"bad\u001b@"},Enumerable.Repeat("X",33).ToArray(),Enumerable.Repeat(new string('中',90),20).ToArray()}){
                try{RollPrinter.Encode(invalid);return 2;}catch(ArgumentException){}
            }
            string scratch=Path.Combine(Path.GetTempPath(),"PmsReceiptTest-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(scratch);
            try {
                var now=DateTime.UtcNow;
                var job=new JavaScriptSerializer().Deserialize<Reply>("{\"job\":{\"id\":1,\"lines\":[\"test\"]}}").job;
                Reserve(scratch,job.id,now);
                try{Reserve(scratch,job.id,now);return 3;}catch(InvalidDataException){}
                for(int i=2;i<=6;i++)Reserve(scratch,i,now);
                try{Reserve(scratch,7,now);return 4;}catch(InvalidOperationException){}
                Reserve(scratch,8,now.AddMinutes(2));
            }finally{foreach(string file in Directory.GetFiles(scratch))File.Delete(file);Directory.Delete(scratch);}
            return 0;
        }
        if(args.Contains("--service")){ServiceBase.Run(new ReceiptService());return 0;}
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.Run(new Setup());return 0;
    }
}
