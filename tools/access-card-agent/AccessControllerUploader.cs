using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessControllerUploadResult
    {
        public int buildingId { get; set; }
        public string buildingNo { get; set; }
        public string accessSystem { get; set; }
        public string status { get; set; }
        public string controller { get; set; }
        public string door { get; set; }
        public string protocol { get; set; }
        public string acknowledgement { get; set; }
    }

    /**
     * 通过现场原管理软件的通信 DLL 下发单卡权限。
     * 只在控制器返回原软件定义的成功码 0 后，才返回 controller_uploaded。
     */
    internal static class AccessControllerUploader
    {
        public static bool CanUpload(AgentConfig config)
        {
            string ignored;
            return TryFindWgComm(config, out ignored);
        }

        public static object[] Upload(AgentConfig config, string password, AgentTask task)
        {
            if (task == null) throw new ArgumentNullException("task");
            var results = new List<object>();
            var icTargets = task.targetBuildings.Where(item => item.accessSystem == "iccard").ToArray();
            var mjTargets = task.targetBuildings.Where(item => item.accessSystem == "mjsystem").ToArray();

            if (icTargets.Length > 0)
                results.AddRange(UploadIcCard(config, password, task, icTargets));
            if (mjTargets.Length > 0)
                results.AddRange(UploadMjSystem(config, task, mjTargets));
            return results.ToArray();
        }

        /** 现场故障路径验收：只向指定 MjSystem 门控制器发送已存在的测试卡。 */
        public static object UploadMjSystemDoorForDiagnostic(AgentConfig config, string cardNo, string doorId)
        {
            if (!String.Equals(cardNo, "22345575", StringComparison.Ordinal) ||
                !String.Equals(doorId, "M0030-1", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("故障验收只允许测试卡 WG 22345575 和 26 号楼控制器 M0030-1");

            string dllPath;
            if (!TryFindWgComm(config, out dllPath))
                throw new FileNotFoundException("找不到原门禁通信组件 iCCard-WGComm.dll，请确认 iCCard 安装目录完整");
            var vendor = new WgCommVendor(dllPath);
            using (var connection = OpenMjSystem(config.MjSystemDatabasePath))
            {
                var record = ReadMjSystemUploadRecord(connection, cardNo, doorId);
                var frame = vendor.BuildOldAddFrame(record, 1);
                string response;
                var result = vendor.Send(record.CommMode, record.IpAddress, record.Port, frame, out response);
                if (result != 0)
                    throw new InvalidOperationException(
                        "26号楼控制器无应答（" + record.ControllerName + " / " + record.CommMode +
                        "，返回码 " + result.ToString(CultureInfo.InvariantCulture) + "）。PMS 应保留为失败可重试，不得显示已下发");
                return new AccessControllerUploadResult
                {
                    buildingId = 26,
                    buildingNo = "26",
                    accessSystem = "mjsystem",
                    status = "controller_uploaded",
                    controller = record.ControllerName + " / SN " + record.ControllerSn,
                    door = record.DoorName,
                    protocol = "MjSystem 0x7E / " + record.CommMode,
                    acknowledgement = String.IsNullOrWhiteSpace(response) ? "控制器已确认" : "控制器已确认，响应 " + Limit(response, 80)
                };
            }
        }

        private static IEnumerable<object> UploadMjSystem(
            AgentConfig config,
            AgentTask task,
            AccessTargetBuilding[] targets)
        {
            string dllPath;
            if (!TryFindWgComm(config, out dllPath))
                throw new FileNotFoundException("找不到原门禁通信组件 iCCard-WGComm.dll，请确认 iCCard 安装目录完整");

            var vendor = new WgCommVendor(dllPath);
            var output = new List<object>();
            using (var connection = OpenMjSystem(config.MjSystemDatabasePath))
            {
                foreach (var target in targets)
                {
                    foreach (var doorId in MjSystemDoors(target.buildingNo))
                    {
                        var record = ReadMjSystemUploadRecord(connection, task.wgCardNo, doorId);
                        var frame = vendor.BuildOldAddFrame(record, 1);
                        string response;
                        var result = vendor.Send(record.CommMode, record.IpAddress, record.Port, frame, out response);
                        if (result != 0)
                        {
                            throw new InvalidOperationException(
                                target.buildingNo + "号楼控制器未确认接收（" + record.ControllerName + " / " + record.CommMode +
                                "，返回码 " + result.ToString(CultureInfo.InvariantCulture) + "）。请关闭占用 COM1 的旧管理软件、检查控制器供电和串口后重试");
                        }

                        output.Add(new AccessControllerUploadResult
                        {
                            buildingId = target.id,
                            buildingNo = target.buildingNo,
                            accessSystem = "mjsystem",
                            status = "controller_uploaded",
                            controller = record.ControllerName + " / SN " + record.ControllerSn,
                            door = record.DoorName,
                            protocol = "MjSystem 0x7E / " + record.CommMode,
                            acknowledgement = String.IsNullOrWhiteSpace(response) ? "控制器已确认" : "控制器已确认，响应 " + Limit(response, 80)
                        });
                    }
                }
            }
            return output;
        }

        private static IEnumerable<object> UploadIcCard(
            AgentConfig config,
            string password,
            AgentTask task,
            AccessTargetBuilding[] targets)
        {
            string dllPath;
            if (!TryFindWgComm(config, out dllPath))
                throw new FileNotFoundException("找不到原门禁通信组件 iCCard-WGComm.dll，请确认 iCCard 安装目录完整");

            var vendor = new WgCommVendor(dllPath);
            var output = new List<object>();
            using (var connection = Open(config.IcCardDatabasePath, password))
            {
                foreach (var target in targets)
                {
                    foreach (var doorId in IcCardDoors(connection, target.buildingNo))
                    {
                        var record = ReadIcCardUploadRecord(connection, task.wgCardNo, doorId);
                        var frame = vendor.BuildOldAddFrame(record, 1);
                        string response;
                        var result = vendor.Send(record.CommMode, record.IpAddress, record.Port, frame, out response);
                        if (result != 0)
                        {
                            throw new InvalidOperationException(
                                target.buildingNo + "号楼控制器未确认接收（" + record.IpAddress + ":" + record.Port +
                                "，返回码 " + result.ToString(CultureInfo.InvariantCulture) + "）。请检查控制器供电和网络后重试");
                        }

                        output.Add(new AccessControllerUploadResult
                        {
                            buildingId = target.id,
                            buildingNo = target.buildingNo,
                            accessSystem = "iccard",
                            status = "controller_uploaded",
                            controller = record.ControllerName + " / SN " + record.ControllerSn,
                            door = record.DoorName,
                            protocol = "iCCard 0x7E / UDP",
                            acknowledgement = String.IsNullOrWhiteSpace(response) ? "控制器已确认" : "控制器已确认，响应 " + Limit(response, 80)
                        });
                    }
                }
            }
            return output;
        }

        private static ControllerUploadRecord ReadIcCardUploadRecord(OleDbConnection connection, string cardNo, int doorId)
        {
            const string sql =
                "SELECT TOP 1 P.f_CardNO,P.f_DoorNO,P.f_BeginYMD,P.f_EndYMD,P.f_ControlSegID,P.f_Password," +
                "C.f_ControllerSN,C.f_ControllerName,C.f_ComPort,C.f_IP,C.f_PORT,D.f_DoorName " +
                "FROM (v_d_Privilege AS P INNER JOIN t_b_Door AS D ON P.f_DoorID=D.f_DoorID) " +
                "INNER JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID " +
                "WHERE P.f_CardNO=? AND P.f_DoorID=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                command.Parameters.AddWithValue("@door", doorId);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                        throw new InvalidOperationException("iCCard 数据库中找不到刚写入的卡号和门权限，已停止控制器下发");
                    return new ControllerUploadRecord
                    {
                        CardNo = Convert.ToInt64(reader["f_CardNO"], CultureInfo.InvariantCulture),
                        DoorNo = Convert.ToInt64(reader["f_DoorNO"], CultureInfo.InvariantCulture),
                        BeginDate = Convert.ToDateTime(reader["f_BeginYMD"], CultureInfo.InvariantCulture),
                        EndDate = Convert.ToDateTime(reader["f_EndYMD"], CultureInfo.InvariantCulture),
                        ControlSegmentId = Convert.ToInt64(reader["f_ControlSegID"], CultureInfo.InvariantCulture),
                        Password = reader["f_Password"] == DBNull.Value ? 0L : Convert.ToInt64(reader["f_Password"], CultureInfo.InvariantCulture),
                        ControllerSn = Convert.ToInt64(reader["f_ControllerSN"], CultureInfo.InvariantCulture),
                        ControllerName = Convert.ToString(reader["f_ControllerName"], CultureInfo.InvariantCulture),
                        CommMode = Convert.ToString(reader["f_ComPort"], CultureInfo.InvariantCulture),
                        IpAddress = Convert.ToString(reader["f_IP"], CultureInfo.InvariantCulture),
                        Port = Convert.ToInt32(reader["f_PORT"], CultureInfo.InvariantCulture),
                        DoorName = Convert.ToString(reader["f_DoorName"], CultureInfo.InvariantCulture)
                    };
                }
            }
        }

        private static ControllerUploadRecord ReadMjSystemUploadRecord(OleDbConnection connection, string cardNo, string doorId)
        {
            const string permissionSql =
                "SELECT TOP 1 P.cCardNo,P.cDoorId,P.cTimeId,E.vDoorPassword,E.dBeginDate,E.dEndDate " +
                "FROM MJ_MacPower AS P INNER JOIN Employee AS E ON P.cCardNo=E.vCardNo " +
                "WHERE P.cCardNo=? AND P.cDoorId=?";
            string controllerId;
            ControllerUploadRecord record;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = permissionSql;
                command.Parameters.AddWithValue("@card", cardNo);
                command.Parameters.AddWithValue("@door", doorId);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                        throw new InvalidOperationException("MjSystem 数据库中找不到刚写入的卡号和门权限，已停止控制器下发");
                    var separator = doorId.LastIndexOf('-');
                    if (separator <= 0 || separator >= doorId.Length - 1)
                        throw new InvalidOperationException("MjSystem 门编号格式无法识别：" + doorId);
                    controllerId = doorId.Substring(0, separator);
                    record = new ControllerUploadRecord
                    {
                        CardNo = Convert.ToInt64(reader["cCardNo"], CultureInfo.InvariantCulture),
                        DoorNo = Convert.ToInt64(doorId.Substring(separator + 1), CultureInfo.InvariantCulture),
                        BeginDate = Convert.ToDateTime(reader["dBeginDate"], CultureInfo.InvariantCulture),
                        EndDate = Convert.ToDateTime(reader["dEndDate"], CultureInfo.InvariantCulture),
                        ControlSegmentId = Convert.ToInt64(reader["cTimeId"], CultureInfo.InvariantCulture),
                        Password = reader["vDoorPassword"] == DBNull.Value || String.IsNullOrWhiteSpace(Convert.ToString(reader["vDoorPassword"]))
                            ? 0L : Convert.ToInt64(reader["vDoorPassword"], CultureInfo.InvariantCulture),
                        DoorName = doorId,
                        ControllerName = controllerId
                    };
                }
            }

            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT TOP 1 cMacSn,vConnType,vIp,vCom FROM MJ_MacInfo WHERE cMacId=?";
                command.Parameters.AddWithValue("@controller", controllerId);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read())
                        throw new InvalidOperationException("MjSystem 找不到门 " + doorId + " 对应的控制器配置");
                    record.ControllerSn = Convert.ToInt64(reader["cMacSn"], CultureInfo.InvariantCulture);
                    var com = Convert.ToString(reader["vCom"], CultureInfo.InvariantCulture);
                    var ip = Convert.ToString(reader["vIp"], CultureInfo.InvariantCulture);
                    record.CommMode = !String.IsNullOrWhiteSpace(com) ? com : "IP";
                    record.IpAddress = ip ?? "";
                    record.Port = 60000;
                }
            }
            return record;
        }

        private static OleDbConnection Open(string path, string password)
        {
            if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException("iCCard 数据库不存在", path);
            var builder = new OleDbConnectionStringBuilder
            {
                Provider = "Microsoft.Jet.OLEDB.4.0",
                DataSource = path
            };
            if (!String.IsNullOrEmpty(password)) builder["Jet OLEDB:Database Password"] = password;
            var connection = new OleDbConnection(builder.ConnectionString);
            connection.Open();
            return connection;
        }

        private static OleDbConnection OpenMjSystem(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException("MjSystem 数据库不存在", path);
            var builder = new OleDbConnectionStringBuilder
            {
                Provider = "Microsoft.Jet.OLEDB.4.0",
                DataSource = path
            };
            var connection = new OleDbConnection(builder.ConnectionString);
            connection.Open();
            return connection;
        }

        private static bool TryFindWgComm(AgentConfig config, out string path)
        {
            var candidates = new List<string>();
            if (config != null && !String.IsNullOrWhiteSpace(config.IcCardDatabasePath))
            {
                var databaseDirectory = Path.GetDirectoryName(config.IcCardDatabasePath);
                if (!String.IsNullOrWhiteSpace(databaseDirectory))
                {
                    candidates.Add(Path.Combine(databaseDirectory, "iCCard-WGComm.dll"));
                    var marker = "\\AppData\\Local\\VirtualStore\\";
                    var markerIndex = databaseDirectory.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                    if (markerIndex >= 0)
                    {
                        var relative = databaseDirectory.Substring(markerIndex + marker.Length);
                        var installDirectory = relative;
                        var databaseMarker = "\\Database";
                        var databaseIndex = installDirectory.IndexOf(databaseMarker, StringComparison.OrdinalIgnoreCase);
                        if (databaseIndex >= 0) installDirectory = installDirectory.Substring(0, databaseIndex);
                        candidates.Add(Path.Combine("C:\\", installDirectory, "iCCard-WGComm.dll"));
                    }
                }
            }
            candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "iCCard-WGComm.dll"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "iCCard", "iCCard-WGComm.dll"));

            path = candidates.FirstOrDefault(File.Exists);
            return path != null;
        }

        private static string NormalizeBuilding(string value)
        {
            var trimmed = (value ?? "").TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }

        private static string[] MjSystemDoors(string buildingNo)
        {
            var normalized = NormalizeBuilding(buildingNo);
            if (normalized == "3") return new[] { "M0041-1" };
            if (normalized == "26") return new[] { "M0038-1", "M0003-1", "M0030-1" };
            throw new InvalidOperationException(buildingNo + "号楼 MjSystem 控制器路由无法自动确认，请先核对门名称");
        }

        private static int[] IcCardDoors(OleDbConnection connection, string buildingNo)
        {
            var normalized = NormalizeBuilding(buildingNo);
            var matches = new List<int>();
            const string sql =
                "SELECT D.f_DoorID,D.f_DoorName,C.f_ControllerName " +
                "FROM t_b_Door AS D LEFT JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var doorName = Convert.ToString(reader["f_DoorName"], CultureInfo.InvariantCulture);
                        var controller = Convert.ToString(reader["f_ControllerName"], CultureInfo.InvariantCulture);
                        if (NormalizeBuilding(ExtractBuildingNo(doorName, controller)) == normalized)
                            matches.Add(Convert.ToInt32(reader["f_DoorID"], CultureInfo.InvariantCulture));
                    }
                }
            }
            var doors = matches.Distinct().ToArray();
            if (doors.Length == 0) throw new InvalidOperationException(buildingNo + "号楼在 iCCard 未找到可唯一识别的实体门，请先核对门名称");
            return doors;
        }

        private static string ExtractBuildingNo(params string[] values)
        {
            foreach (var value in values)
            {
                if (String.IsNullOrWhiteSpace(value)) continue;
                var match = System.Text.RegularExpressions.Regex.Match(value, @"(?<!\d)(\d{1,3})\s*(?:号|#)?(?:楼|幢|栋|大门)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (!match.Success) continue;
                return NormalizeBuilding(match.Groups[1].Value);
            }
            return null;
        }

        private static string Limit(string value, int length)
        {
            value = value ?? "";
            return value.Length <= length ? value : value.Substring(0, length);
        }

        private sealed class ControllerUploadRecord
        {
            public long CardNo;
            public long DoorNo;
            public DateTime BeginDate;
            public DateTime EndDate;
            public long ControlSegmentId;
            public long Password;
            public long ControllerSn;
            public string ControllerName;
            public string CommMode;
            public string IpAddress;
            public int Port;
            public string DoorName;
        }

        private sealed class WgCommVendor
        {
            private readonly Type _toolsType;
            private readonly Type _operateType;

            public WgCommVendor(string dllPath)
            {
                var assembly = Assembly.LoadFrom(dllPath);
                _toolsType = assembly.GetType("WgiCCard.wgTools", true);
                _operateType = assembly.GetType("WgiCCard.wgCommOperate", true);
            }

            public string BuildOldAddFrame(ControllerUploadRecord record, int sequence)
            {
                if (!Convert.ToBoolean(CallTool("isValidWg26Card", record.CardNo), CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("WG 卡号不符合原 iCCard 控制器规则");
                if (record.ControllerSn < 0 || record.ControllerSn > 65535)
                    throw new InvalidOperationException("控制器序列号超出旧版协议范围");

                var serialHex = record.ControllerSn.ToString("X4", CultureInfo.InvariantCulture);
                var body = serialHex.Substring(2, 2) + serialHex.Substring(0, 2) + "0711";
                body += Convert.ToString(CallTool("intToStr4", sequence), CultureInfo.InvariantCulture);
                body += Convert.ToString(CallTool("intToStr4", Convert.ToInt32(record.CardNo % 100000)), CultureInfo.InvariantCulture);
                body += Convert.ToString(CallTool("bytToStr", record.CardNo / 100000), CultureInfo.InvariantCulture);
                body += Convert.ToString(CallTool("bytToStr", record.DoorNo), CultureInfo.InvariantCulture);
                body += WgDate(record.BeginDate);
                body += WgDate(record.EndDate);
                body += Convert.ToString(CallTool("bytToStr", record.ControlSegmentId), CultureInfo.InvariantCulture);
                var password = Convert.ToString(CallTool("lngToStr8", record.Password), CultureInfo.InvariantCulture);
                body += password.Substring(0, 6);
                body += "0000"; // 首卡标志、组合开门组；当前业务均未启用。
                body = body.PadRight(60, '0');
                body += Convert.ToString(CallTool("_checkSum", body), CultureInfo.InvariantCulture);
                return "7E" + body + "0D";
            }

            public long Send(string commMode, string ipAddress, int port, string frame, out string response)
            {
                var operation = Activator.CreateInstance(_operateType);
                try
                {
                    // 原软件此型号使用 UDP；bTCPIP=false 是供应商 DLL 的默认值，这里显式固定。
                    var tcpField = _operateType.GetField("bTCPIP", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (tcpField != null) tcpField.SetValue(operation, false);

                    var tcpClientIndex = 0;
                    var openArguments = new object[] { commMode, ipAddress, port.ToString(CultureInfo.InvariantCulture), 5000, tcpClientIndex };
                    var openResult = Convert.ToInt64(InvokeInstance(operation, "comm_open", openArguments), CultureInfo.InvariantCulture);
                    if (openResult != 0)
                    {
                        response = "";
                        return openResult;
                    }

                    var validPort = Convert.ToInt32(CallTool("getValidIPPort", port.ToString(CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
                    var getArguments = new object[] { commMode, ipAddress, frame, 5400, Convert.ToInt32(openArguments[4]), "", validPort };
                    var result = Convert.ToInt64(InvokeInstance(operation, "comm_get", getArguments), CultureInfo.InvariantCulture);
                    response = Convert.ToString(getArguments[5], CultureInfo.InvariantCulture);
                    return result;
                }
                finally
                {
                    try { InvokeInstance(operation, "comm_close", new object[0]); }
                    catch { }
                }
            }

            private string WgDate(DateTime value)
            {
                var arguments = new object[] { value, (byte)0, (byte)0, (byte)0, (byte)0 };
                var result = Convert.ToInt64(InvokeStatic(_toolsType, "msDateToWgDate", arguments), CultureInfo.InvariantCulture);
                if (result != 0) throw new InvalidOperationException("门禁有效期无法转换为控制器格式");
                return Convert.ToString(CallTool("bytToStr", Convert.ToInt64(arguments[2])), CultureInfo.InvariantCulture) +
                       Convert.ToString(CallTool("bytToStr", Convert.ToInt64(arguments[1])), CultureInfo.InvariantCulture);
            }

            private object CallTool(string name, object argument)
            {
                return InvokeStatic(_toolsType, name, new[] { argument });
            }

            private static object InvokeStatic(Type type, string name, object[] arguments)
            {
                var method = FindMethod(type, name, arguments.Length, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                return method.Invoke(null, arguments);
            }

            private static object InvokeInstance(object instance, string name, object[] arguments)
            {
                var method = FindMethod(instance.GetType(), name, arguments.Length, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                return method.Invoke(instance, arguments);
            }

            private static MethodInfo FindMethod(Type type, string name, int parameterCount, BindingFlags flags)
            {
                var method = type.GetMethods(flags).FirstOrDefault(value => value.Name == name && value.GetParameters().Length == parameterCount);
                if (method == null) throw new MissingMethodException(type.FullName, name);
                return method;
            }
        }
    }
}
