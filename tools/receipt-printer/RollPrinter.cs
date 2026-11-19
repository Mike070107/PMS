using System;
using System.ComponentModel;
using System.Drawing.Printing;
using System.Runtime.InteropServices;
using System.Text;

internal static class RollPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Document { public string name, output, type; }
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool OpenPrinter(string name,out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] static extern int StartDocPrinter(IntPtr handle,int level,ref Document doc);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool WritePrinter(IntPtr handle,byte[] buffer,int length,out int written);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool AbortPrinter(IntPtr handle);
    [DllImport("winspool.drv",SetLastError=true)] static extern bool ClosePrinter(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct PrinterInfo {
        public IntPtr server,name,share,port,driver,comment,location,mode,separator,processor,dataType,parameters,security;
        public uint attributes,priority,defaultPriority,startTime,untilTime,status,jobs,averagePpm;
    }
    [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool GetPrinter(IntPtr handle,int level,IntPtr buffer,int size,out int needed);
    public static bool Ready(string queue) {
        IntPtr handle;
        if(!OpenPrinter(queue,out handle,IntPtr.Zero)) return false;
        try {
            int needed;GetPrinter(handle,2,IntPtr.Zero,0,out needed);
            if(needed<=0 || needed>1048576)return false;
            var buffer=Marshal.AllocHGlobal(needed);
            try {
                if(!GetPrinter(handle,2,buffer,needed,out needed))return false;
                var info=(PrinterInfo)Marshal.PtrToStructure(buffer,typeof(PrinterInfo));
                // Only claim work when the physical queue is idle and free of reported errors.
                return info.status==0 && info.jobs==0 && (info.attributes & 0x400)==0;
            } finally {Marshal.FreeHGlobal(buffer);}
        } finally {ClosePrinter(handle);}
    }
    public static byte[] Encode(string[] lines) {
        if(lines==null || lines.Length<1 || lines.Length>32) throw new ArgumentException("票面行数超限");
        var encoding=Encoding.GetEncoding(936,EncoderFallback.ExceptionFallback,DecoderFallback.ExceptionFallback);
        var bytes=new System.Collections.Generic.List<byte>(new byte[]{27,64,28,38});
        int physical=0;
        foreach(string line in lines) {
            if(String.IsNullOrWhiteSpace(line) || line.Length>90) throw new ArgumentException("无效票面");
            foreach(char c in line) if(Char.IsControl(c)) throw new ArgumentException("票面包含控制字符");
            byte[] data=encoding.GetBytes(line);
            physical+=(data.Length+41)/42;
            if(physical>45) throw new ArgumentException("小票过长");
            bytes.AddRange(data); bytes.Add(10);
        }
        // One ticket, one cut. No form feed or blank footer.
        bytes.AddRange(new byte[]{29,86,0});
        return bytes.ToArray();
    }
    public static void Print(string queue,int id,string[] lines) {
        byte[] data=Encode(lines);
        bool found=false;
        foreach(string printer in PrinterSettings.InstalledPrinters) if(printer==queue) found=true;
        if(!found) throw new InvalidOperationException("指定打印机没有安装");
        IntPtr handle;
        if(!OpenPrinter(queue,out handle,IntPtr.Zero)) throw new Win32Exception();
        bool started=false;
        try {
            var doc=new Document{name="PMS 小票 "+id,type="RAW"};
            if(StartDocPrinter(handle,1,ref doc)==0) throw new Win32Exception();
            started=true;int written;
            if(!StartPagePrinter(handle) || !WritePrinter(handle,data,data.Length,out written) || written!=data.Length ||
               !EndPagePrinter(handle) || !EndDocPrinter(handle)) throw new Win32Exception();
            started=false;
        } finally {if(started) AbortPrinter(handle);ClosePrinter(handle);}
    }
}
