using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

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
     * 只在控制器的真实回包通过原 SDK 校验后，才返回 controller_uploaded。
     */
    internal static class AccessControllerUploader
    {
        private const string MjSystemSerialSendMethod = "GetAndSendInfo34Or26";

        public static bool CanUpload(AgentConfig config)
        {
            string ignoredWg;
            string ignoredMj;
            return TryFindWgComm(config, out ignoredWg) && TryFindMjSystemSdk(config, out ignoredMj);
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
                results.AddRange(RunMjSystemSta(delegate { return UploadMjSystem(config, task, mjTargets).ToArray(); }));
            return results.ToArray();
        }

        /** 现场故障路径验收：只向指定 MjSystem 门控制器发送已存在的测试卡。 */
        public static object UploadMjSystemDoorForDiagnostic(AgentConfig config, string cardNo, string doorId)
        {
            return RunMjSystemSta(delegate { return UploadMjSystemDoorForDiagnosticCore(config, cardNo, doorId); });
        }

        private static object UploadMjSystemDoorForDiagnosticCore(AgentConfig config, string cardNo, string doorId)
        {
            if (!String.Equals(cardNo, "22345575", StringComparison.Ordinal) ||
                !String.Equals(doorId, "M0030-1", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("故障验收只允许测试卡 WG 22345575 和 26 号楼控制器 M0030-1");

            string mjSdkPath;
            if (!TryFindMjSystemSdk(config, out mjSdkPath))
                throw new FileNotFoundException("找不到 MjSystem 原生通信组件 ECardDerviceSDKMJ.dll，请确认 MjSystem 安装目录完整");
            var vendor = new MjSystemVendor(mjSdkPath);
            try
            {
                using (var connection = OpenMjSystem(config.MjSystemDatabasePath))
                {
                    var record = ReadMjSystemUploadRecord(connection, cardNo, doorId);
                    var cardProtocol = ResolveMjSystemCardProtocol(config.MjSystemDatabasePath);
                    var frame = vendor.BuildPermissionCommand(record, 1, cardProtocol);
                    string response;
                    var result = vendor.Send(
                        record.CommMode,
                        record.IpAddress,
                        record.Port,
                        frame,
                        IsMjSystemSerial(record.CommMode) ? cardProtocol : null,
                        out response);
                    if (result != 0)
                        throw new InvalidOperationException(
                            "26号楼控制器通信失败（" + record.ControllerName + " / " + record.CommMode + "）：" +
                            DescribeMjSystemError(result, response) + "。PMS 应保留为失败可重试，不得显示已下发");
                    return new AccessControllerUploadResult
                    {
                        buildingId = 26,
                        buildingNo = "26",
                        accessSystem = "mjsystem",
                        status = "controller_uploaded",
                        controller = record.ControllerName + " / SN " + record.ControllerSnText,
                        door = record.DoorName,
                        protocol = "MjSystem 原生 SDK 0x9E / " + record.CommMode,
                        acknowledgement = String.IsNullOrWhiteSpace(response) ? "控制器已确认" : "控制器已确认，响应 " + Limit(response, 80)
                    };
                }
            }
            finally
            {
                vendor.Dispose();
            }
        }

        internal static ApartmentState MjSystemApartmentForTest()
        {
            return RunMjSystemSta(delegate { return Thread.CurrentThread.GetApartmentState(); });
        }

        private static T RunMjSystemSta<T>(Func<T> action)
        {
            if (action == null) throw new ArgumentNullException("action");
            T result = default(T);
            Exception error = null;
            using (var completed = new ManualResetEvent(false))
            {
                var thread = new Thread(new ThreadStart(delegate
                {
                    var initialized = false;
                    try
                    {
                        var oleResult = OleInitialize(IntPtr.Zero);
                        if (oleResult < 0)
                            Marshal.ThrowExceptionForHR(oleResult);
                        initialized = true;
                        result = action();
                    }
                    catch (Exception exception)
                    {
                        error = exception;
                    }
                    finally
                    {
                        if (initialized) OleUninitialize();
                        completed.Set();
                    }
                }));
                thread.IsBackground = true;
                thread.Name = "PMS-MjSystem-SDK-STA";
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                completed.WaitOne();
            }
            if (error != null) throw error;
            return result;
        }

        private static IEnumerable<object> UploadMjSystem(
            AgentConfig config,
            AgentTask task,
            AccessTargetBuilding[] targets)
        {
            string mjSdkPath;
            if (!TryFindMjSystemSdk(config, out mjSdkPath))
                throw new FileNotFoundException("找不到 MjSystem 原生通信组件 ECardDerviceSDKMJ.dll，请确认 MjSystem 安装目录完整");

            var vendor = new MjSystemVendor(mjSdkPath);
            var output = new List<object>();
            try
            {
                using (var connection = OpenMjSystem(config.MjSystemDatabasePath))
                {
                    var cardProtocol = ResolveMjSystemCardProtocol(config.MjSystemDatabasePath);
                    foreach (var target in targets)
                    {
                        foreach (var doorId in MjSystemDoors(connection, target.buildingNo))
                        {
                            var record = ReadMjSystemUploadRecord(connection, task.wgCardNo, doorId);
                            var frame = vendor.BuildPermissionCommand(record, 1, cardProtocol);
                            string response;
                            var result = vendor.Send(
                                record.CommMode,
                                record.IpAddress,
                                record.Port,
                                frame,
                                IsMjSystemSerial(record.CommMode) ? cardProtocol : null,
                                out response);
                            if (result != 0)
                            {
                                throw new InvalidOperationException(
                                    target.buildingNo + "号楼控制器通信失败（" + record.ControllerName + " / " + record.CommMode + "）：" +
                                    DescribeMjSystemError(result, response));
                            }

                            output.Add(new AccessControllerUploadResult
                            {
                                buildingId = target.id,
                                buildingNo = target.buildingNo,
                                accessSystem = "mjsystem",
                                status = "controller_uploaded",
                                controller = record.ControllerName + " / SN " + record.ControllerSnText,
                                door = record.DoorName,
                                protocol = "MjSystem 原生 SDK 0x9E / " + record.CommMode,
                                acknowledgement = String.IsNullOrWhiteSpace(response) ? "控制器已确认" : "控制器已确认，响应 " + Limit(response, 80)
                            });
                        }
                    }
                }
            }
            finally
            {
                vendor.Dispose();
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
                "SELECT TOP 1 P.cCardNo,P.cDoorId,P.cTimeId,E.vDoorPassword,E.dBeginDate,E.dEndDate,E.vEmp_id,E.vEmp_name " +
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
                        DoorPasswordText = reader["vDoorPassword"] == DBNull.Value
                            ? "" : Convert.ToString(reader["vDoorPassword"], CultureInfo.InvariantCulture),
                        EmployeeId = Convert.ToString(reader["vEmp_id"], CultureInfo.InvariantCulture),
                        EmployeeName = Convert.ToString(reader["vEmp_name"], CultureInfo.InvariantCulture),
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
                    record.ControllerSnText = Convert.ToString(reader["cMacSn"], CultureInfo.InvariantCulture).Trim();
                    record.ControllerSn = Convert.ToInt64(record.ControllerSnText, CultureInfo.InvariantCulture);
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

        private static bool TryFindMjSystemSdk(AgentConfig config, out string path)
        {
            var candidates = new List<string>();
            if (config != null && !String.IsNullOrWhiteSpace(config.MjSystemDatabasePath))
            {
                var databaseDirectory = Path.GetDirectoryName(config.MjSystemDatabasePath);
                if (!String.IsNullOrWhiteSpace(databaseDirectory))
                {
                    candidates.Add(Path.GetFullPath(Path.Combine(databaseDirectory, "..", "..", "ECardDerviceSDKMJ.dll")));
                    var marker = "\\AppData\\Local\\VirtualStore\\";
                    var markerIndex = databaseDirectory.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                    if (markerIndex >= 0)
                    {
                        var relative = databaseDirectory.Substring(markerIndex + marker.Length);
                        var databaseIndex = relative.IndexOf("\\Database", StringComparison.OrdinalIgnoreCase);
                        if (databaseIndex >= 0) relative = relative.Substring(0, databaseIndex);
                        candidates.Add(Path.Combine("C:\\", relative, "ECardDerviceSDKMJ.dll"));
                    }
                }
            }
            candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ECardDerviceSDKMJ.dll"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "MjSystem", "ECardDerviceSDKMJ.dll"));
            path = candidates.FirstOrDefault(File.Exists);
            return path != null;
        }

        internal static string ResolveMjSystemCardProtocol(string databasePath)
        {
            if (String.IsNullOrWhiteSpace(databasePath))
                throw new InvalidOperationException("MjSystem 数据库路径为空，无法读取卡片协议");

            var databaseDirectory = Path.GetDirectoryName(databasePath);
            var language = databaseDirectory == null ? "ChineseSimple" : new DirectoryInfo(databaseDirectory).Name;
            var databaseRoot = databaseDirectory == null ? null : Directory.GetParent(databaseDirectory);
            var installRoot = databaseRoot == null ? null : databaseRoot.Parent;
            var candidates = new List<string>();
            if (installRoot != null)
                candidates.Add(Path.Combine(installRoot.FullName, "Ini", language, "dbconnect.ini"));

            var virtualStoreMarker = "\\AppData\\Local\\VirtualStore\\";
            var markerIndex = databasePath.IndexOf(virtualStoreMarker, StringComparison.OrdinalIgnoreCase);
            if (markerIndex >= 0 && installRoot != null)
            {
                var relativeInstall = installRoot.FullName.Substring(markerIndex + virtualStoreMarker.Length);
                candidates.Add(Path.Combine("C:\\", relativeInstall, "Ini", language, "dbconnect.ini"));
            }

            foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (!File.Exists(candidate)) continue;
                var inSendKey = false;
                foreach (var rawLine in File.ReadAllLines(candidate))
                {
                    var line = (rawLine ?? "").Trim();
                    if (line.StartsWith("[", StringComparison.Ordinal) && line.EndsWith("]", StringComparison.Ordinal))
                    {
                        inSendKey = String.Equals(line, "[SendKey]", StringComparison.OrdinalIgnoreCase);
                        continue;
                    }
                    if (!inSendKey) continue;
                    var separator = line.IndexOf('=');
                    if (separator <= 0 || !String.Equals(line.Substring(0, separator).Trim(), "SendKey", StringComparison.OrdinalIgnoreCase))
                        continue;
                    var value = line.Substring(separator + 1).Trim();
                    if (value == "0" || value == "1") return value;
                    throw new InvalidOperationException("MjSystem 卡片协议配置无效：" + value + "（" + candidate + "）");
                }
            }

            throw new FileNotFoundException(
                "未找到 MjSystem 卡片协议配置 [SendKey] SendKey，无法安全选择 WG26/WG34 下发协议",
                candidates.FirstOrDefault() ?? databasePath);
        }

        internal static string MjSystemSerialSendMethodForTest()
        {
            return MjSystemSerialSendMethod;
        }

        private static bool IsMjSystemSerial(string commMode)
        {
            return (commMode ?? "").StartsWith("COM", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeBuilding(string value)
        {
            var trimmed = (value ?? "").TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }

        internal static string NormalizeMjSystemControllerSerial(string controllerSn)
        {
            controllerSn = (controllerSn ?? "").Trim();
            long parsed;
            if (controllerSn.Length == 0 || controllerSn.Length > 9 ||
                !Int64.TryParse(controllerSn, NumberStyles.None, CultureInfo.InvariantCulture, out parsed))
                throw new InvalidOperationException("MjSystem 控制器序列号格式无效：" + controllerSn);
            return controllerSn;
        }

        internal static object[] BuildMjSystemPermissionArguments(
            string controllerSn,
            string employeeId,
            long cardNo,
            int sequence,
            DateTime beginDate,
            DateTime endDate,
            long controlSegmentId,
            string doorPassword,
            string employeeName,
            string cardProtocol)
        {
            if (cardProtocol != "0" && cardProtocol != "1")
                throw new InvalidOperationException("MjSystem 卡片协议必须是旧管理软件配置的 0 或 1");
            if (sequence <= 0) throw new InvalidOperationException("MjSystem 下发序号必须大于 0");

            var arguments = new object[48];
            for (var index = 0; index < arguments.Length; index++) arguments[index] = "";
            arguments[0] = "1D";
            arguments[1] = NormalizeMjSystemControllerSerial(controllerSn);
            arguments[2] = employeeId ?? "";
            arguments[3] = cardNo.ToString(CultureInfo.InvariantCulture);
            arguments[4] = sequence.ToString(CultureInfo.InvariantCulture);
            arguments[5] = beginDate.ToString("yyyy/M/d H:mm:ss", CultureInfo.InvariantCulture);
            arguments[6] = endDate.ToString("yyyy/M/d H:mm:ss", CultureInfo.InvariantCulture);
            arguments[7] = controlSegmentId.ToString(CultureInfo.InvariantCulture);
            arguments[8] = String.IsNullOrWhiteSpace(doorPassword) ? "000000" : doorPassword.Trim();
            arguments[9] = employeeName ?? "";
            arguments[10] = cardProtocol;
            return arguments;
        }

        private static string[] MjSystemDoors(OleDbConnection connection, string buildingNo)
        {
            var normalized = NormalizeBuilding(buildingNo);
            if (normalized == "3") return new[] { "M0041-1" };
            if (normalized == "26") return new[] { "M0038-1", "M0003-1", "M0030-1" };
            var matches = new List<string>();
            const string sql =
                "SELECT D.cDoorId,D.vDoorName,M.vExposition " +
                "FROM MJ_DoorInfo AS D LEFT JOIN MJ_MacInfo AS M ON D.cMacId=M.cMacId";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var doorId = Convert.ToString(reader["cDoorId"], CultureInfo.InvariantCulture);
                        var doorName = Convert.ToString(reader["vDoorName"], CultureInfo.InvariantCulture);
                        var controller = Convert.ToString(reader["vExposition"], CultureInfo.InvariantCulture);
                        if (NormalizeBuilding(AccessGatewayDatabase.ExtractBuildingNo(doorName, controller)) == normalized)
                            matches.Add(doorId);
                    }
                }
            }
            var doors = matches.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (doors.Length == 0)
                throw new InvalidOperationException(buildingNo + "号楼在 MjSystem 未找到可唯一识别的实体门，请先核对门名称");
            return doors;
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
                        if (NormalizeBuilding(AccessGatewayDatabase.ExtractBuildingNo(doorName, controller)) == normalized)
                            matches.Add(Convert.ToInt32(reader["f_DoorID"], CultureInfo.InvariantCulture));
                    }
                }
            }
            var doors = matches.Distinct().ToArray();
            if (doors.Length == 0) throw new InvalidOperationException(buildingNo + "号楼在 iCCard 未找到可唯一识别的实体门，请先核对门名称");
            return doors;
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
            public string DoorPasswordText;
            public string EmployeeId;
            public string EmployeeName;
            public long ControllerSn;
            public string ControllerSnText;
            public string ControllerName;
            public string CommMode;
            public string IpAddress;
            public int Port;
            public string DoorName;
        }

        private sealed class MjSystemVendor : IDisposable
        {
            private static readonly Guid ClassId = new Guid("DB4500C7-1C60-4D2D-923D-357841086053");
            private static readonly Guid ClassFactoryId = new Guid("00000001-0000-0000-C000-000000000046");
            private static readonly Guid DispatchId = new Guid("00020400-0000-0000-C000-000000000046");
            private IntPtr _module;
            private object _instance;

            public MjSystemVendor(string dllPath)
            {
                if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
                    throw new InvalidOperationException("MjSystem 原生 SDK 必须在 STA/OLE 线程中运行");
                _module = LoadLibrary(dllPath);
                if (_module == IntPtr.Zero)
                    throw new InvalidOperationException("无法加载 MjSystem 原生通信组件，Windows 错误 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                var address = GetProcAddress(_module, "DllGetClassObject");
                if (address == IntPtr.Zero) throw new InvalidOperationException("MjSystem 原生通信组件缺少 DllGetClassObject");
                var getClassObject = (DllGetClassObjectDelegate)Marshal.GetDelegateForFunctionPointer(address, typeof(DllGetClassObjectDelegate));
                IntPtr factoryPointer;
                var classId = ClassId;
                var factoryId = ClassFactoryId;
                Marshal.ThrowExceptionForHR(getClassObject(ref classId, ref factoryId, out factoryPointer));
                IClassFactory factory = null;
                try
                {
                    factory = (IClassFactory)Marshal.GetObjectForIUnknown(factoryPointer);
                    IntPtr instancePointer;
                    var dispatchId = DispatchId;
                    Marshal.ThrowExceptionForHR(factory.CreateInstance(IntPtr.Zero, ref dispatchId, out instancePointer));
                    try { _instance = Marshal.GetObjectForIUnknown(instancePointer); }
                    finally { Marshal.Release(instancePointer); }
                }
                finally
                {
                    Marshal.Release(factoryPointer);
                    if (factory != null && Marshal.IsComObject(factory)) Marshal.ReleaseComObject(factory);
                }
            }

            public string BuildPermissionCommand(ControllerUploadRecord record, int sequence, string cardProtocol)
            {
                if (record == null) throw new ArgumentNullException("record");
                var arguments = BuildMjSystemPermissionArguments(
                    record.ControllerSnText,
                    record.EmployeeId,
                    record.CardNo,
                    sequence,
                    record.BeginDate,
                    record.EndDate,
                    record.ControlSegmentId,
                    record.DoorPasswordText,
                    record.EmployeeName,
                    cardProtocol);
                // 原 IISSystem.exe 为 1D（新增权限）直接调用该 SDK 方法，其返回值已是完整 0x9E 指令。
                // 不得再把返回值交给 CreatCmd 二次包装。
                var result = Convert.ToString(InvokeAllInOutStrings("CreateBstrFuncData", arguments), CultureInfo.InvariantCulture);
                if (String.IsNullOrWhiteSpace(result))
                    throw new InvalidOperationException("MjSystem 原生 SDK 未能生成控制器命令（错误码 " + ErrorCode().ToString(CultureInfo.InvariantCulture) + "）");
                return result;
            }

            public long Send(string commMode, string ipAddress, int port, string frame, string cardProtocol, out string response)
            {
                try
                {
                    object[] arguments;
                    string methodReturn;
                    if (IsMjSystemSerial(commMode))
                    {
                        short comPort;
                        if (!Int16.TryParse(commMode.Substring(3), NumberStyles.None, CultureInfo.InvariantCulture, out comPort) || comPort <= 0)
                            throw new InvalidOperationException("MjSystem 串口配置无法识别：" + commMode);
                        if (cardProtocol != "0" && cardProtocol != "1")
                            throw new InvalidOperationException("MjSystem 卡片协议必须是旧管理软件配置的 0 或 1");
                        arguments = new object[] { comPort, frame, cardProtocol };
                        methodReturn = Convert.ToString(InvokeWithInOutStrings(MjSystemSerialSendMethod, arguments, 1, 2), CultureInfo.InvariantCulture);
                    }
                    else
                    {
                        arguments = new object[] { ipAddress ?? "", port, frame };
                        methodReturn = Convert.ToString(InvokeWithInOutStrings("GetAndSendTcpData", arguments, 2), CultureInfo.InvariantCulture);
                    }
                    var inOutValue = Convert.ToString(
                        IsMjSystemSerial(commMode) ? arguments[1] : arguments[2],
                        CultureInfo.InvariantCulture);
                    var sendError = ErrorCode();
                    response = SelectMjSystemControllerResponse(frame, methodReturn, inOutValue);
                    if (!String.IsNullOrWhiteSpace(response))
                    {
                        var validation = new object[] { response };
                        if (Convert.ToBoolean(InvokeWithInOutStrings("ThenCommandVail", validation, 0), CultureInfo.InvariantCulture))
                            return 0L;
                    }

                    response = DescribeMjSystemSdkExchange(frame, methodReturn, inOutValue);
                    return sendError == 0 ? ErrorCodeOrFallback() : sendError;
                }
                finally
                {
                    try { Invoke("CloseComm", new object[0]); }
                    catch { }
                }
            }

            private int ErrorCode()
            {
                return Convert.ToInt32(_instance.GetType().InvokeMember("ErrCode",
                    BindingFlags.GetProperty | BindingFlags.Instance | BindingFlags.Public,
                    null, _instance, new object[0], CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            }

            private long ErrorCodeOrFallback()
            {
                var error = ErrorCode();
                return error == 0 ? -1L : error;
            }

            private object Invoke(string name, object[] arguments)
            {
                return _instance.GetType().InvokeMember(name,
                    BindingFlags.InvokeMethod | BindingFlags.Instance | BindingFlags.Public,
                    null, _instance, arguments, CultureInfo.InvariantCulture);
            }

            private object InvokeWithInOutStrings(string name, object[] arguments, params int[] inOutIndices)
            {
                var modifier = new ParameterModifier(arguments.Length);
                foreach (var inOutIndex in inOutIndices) modifier[inOutIndex] = true;
                return _instance.GetType().InvokeMember(name,
                    BindingFlags.InvokeMethod | BindingFlags.Instance | BindingFlags.Public,
                    null, _instance, arguments, new[] { modifier }, CultureInfo.InvariantCulture, null);
            }

            private object InvokeAllInOutStrings(string name, object[] arguments)
            {
                var modifier = new ParameterModifier(arguments.Length);
                for (var index = 0; index < arguments.Length; index++) modifier[index] = true;
                return _instance.GetType().InvokeMember(name,
                    BindingFlags.InvokeMethod | BindingFlags.Instance | BindingFlags.Public,
                    null, _instance, arguments, new[] { modifier }, CultureInfo.InvariantCulture, null);
            }

            public void Dispose()
            {
                if (_instance != null && Marshal.IsComObject(_instance)) Marshal.FinalReleaseComObject(_instance);
                _instance = null;
                if (_module != IntPtr.Zero) FreeLibrary(_module);
                _module = IntPtr.Zero;
            }

            [ComImport, Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
            private interface IClassFactory
            {
                [PreserveSig]
                int CreateInstance(IntPtr outer, ref Guid interfaceId, out IntPtr instance);
                [PreserveSig]
                int LockServer(bool shouldLock);
            }

            [UnmanagedFunctionPointer(CallingConvention.StdCall)]
            private delegate int DllGetClassObjectDelegate(ref Guid classId, ref Guid interfaceId, out IntPtr instance);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            private static extern IntPtr LoadLibrary(string path);
            [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
            private static extern IntPtr GetProcAddress(IntPtr module, string name);
            [DllImport("kernel32.dll")]
            private static extern bool FreeLibrary(IntPtr module);

        }

        [DllImport("ole32.dll")]
        private static extern int OleInitialize(IntPtr reserved);

        [DllImport("ole32.dll")]
        private static extern void OleUninitialize();

        internal static string DescribeMjSystemError(long errorCode, string response)
        {
            var detail = errorCode == 2
                ? "原生 SDK 未确认本次通信（错误码 2）。该错误不能单独证明 COM1 被占用；请根据后面的 SDK 调用返回和控制器回包继续排查"
                : "原生 SDK 错误码 " + errorCode.ToString(CultureInfo.InvariantCulture);
            if (!String.IsNullOrWhiteSpace(response)) detail += "；" + Limit(response, 180);
            return detail;
        }

        internal static string SelectMjSystemControllerResponse(string request, string methodReturn, string inOutValue)
        {
            request = (request ?? "").Trim();
            methodReturn = (methodReturn ?? "").Trim();
            inOutValue = (inOutValue ?? "").Trim();
            if (inOutValue.Length > 0 && !String.Equals(inOutValue, request, StringComparison.OrdinalIgnoreCase))
                return inOutValue;
            if (methodReturn.Length > 0 && !String.Equals(methodReturn, request, StringComparison.OrdinalIgnoreCase))
                return methodReturn;
            return "";
        }

        internal static string DescribeMjSystemSdkExchange(string request, string methodReturn, string inOutValue)
        {
            request = (request ?? "").Trim();
            methodReturn = (methodReturn ?? "").Trim();
            inOutValue = (inOutValue ?? "").Trim();
            var returned = methodReturn.Length == 0 ? "空" :
                (String.Equals(methodReturn, request, StringComparison.OrdinalIgnoreCase) ? "与发送命令相同" : Limit(methodReturn, 80));
            var reply = inOutValue.Length == 0 ? "空" :
                (String.Equals(inOutValue, request, StringComparison.OrdinalIgnoreCase) ? "仍为发送命令（未收到控制器回包）" : Limit(inOutValue, 80));
            return "SDK 调用返回 " + returned + "；控制器回包 " + reply;
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
                if (record.ControllerSn < 0 || record.ControllerSn > 65535)
                    throw new InvalidOperationException("控制器序列号超出旧版协议范围");

                var serialHex = record.ControllerSn.ToString("X4", CultureInfo.InvariantCulture);
                var body = serialHex.Substring(2, 2) + serialHex.Substring(0, 2) + BuildOldAddFunction(record, sequence);
                body += Convert.ToString(CallTool("_checkSum", body), CultureInfo.InvariantCulture);
                return "7E" + body + "0D";
            }

            public string BuildOldAddFunction(ControllerUploadRecord record, int sequence)
            {
                if (!Convert.ToBoolean(CallTool("isValidWg26Card", record.CardNo), CultureInfo.InvariantCulture))
                    throw new InvalidOperationException("WG 卡号不符合原门禁控制器规则");
                var body = "0711";
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
                return body.PadRight(56, '0');
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
