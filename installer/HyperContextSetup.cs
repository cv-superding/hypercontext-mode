using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Shell;
using Ellipse = System.Windows.Shapes.Ellipse;

[assembly: AssemblyTitle("HyperContext Setup")]
[assembly: AssemblyProduct("HyperContext Mode")]
[assembly: AssemblyCompany("cv-superding")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal sealed class NodeInfo
{
    public string Path = "";
    public string Version = "";
    public bool Ok;
}

internal sealed class SetupApp
{
    private const string NodeZipUrl = "https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip";
    private const string ProjectZipUrl = "https://github.com/cv-superding/hypercontext-mode/archive/refs/heads/main.zip";

    private static readonly Dictionary<string, string> ClientNames = new Dictionary<string, string>
    {
        { "claude-code", "Claude Code" },
        { "codex", "Codex CLI" },
        { "qoder-intl", "Qoder 国际版" },
        { "qoder-cn", "Qoder 国内版" },
        { "workbuddy-intl", "WorkBuddy 国际版" },
        { "workbuddy-cn", "WorkBuddy 国内版" },
        { "dsh", "DeepSeek Harness" },
        { "zcode", "Zcode" }
    };

    private readonly string _localRoot;
    private readonly string _homeDir;
    private readonly string _logFile;

    private Window _window;
    private Grid _root;
    private Border _titleBar;
    private Button _btnMinimize;
    private Button _btnClose;

    private TextBlock _txtProject;
    private TextBlock _txtNode;
    private TextBlock _txtEngines;
    private TextBlock _txtConfig;
    private TextBlock _txtProgress;
    private TextBlock _txtDone;
    private TextBlock _statusText;
    private TextBlock _sidebarStatus;
    private TextBlock _txtFooterNote;
    private Ellipse _dotProject;
    private Ellipse _dotNode;
    private Ellipse _dotEngines;
    private Ellipse _dotConfig;
    private TextBox _txtProxy;
    private TextBox _logBox;
    private Border _statusPill;
    private Border _progressTrack;
    private Border _progressFill;
    private Border _doneCard;
    private Border _logCard;
    private Button _btnBrowse;
    private Button _btnDownloadNode;
    private Button _btnDownloadProject;
    private Button _btnSetupEnv;
    private Button _btnRecheck;
    private Button _btnSelectAll;
    private Button _btnClear;
    private Button _btnStop;
    private Button _btnOpenHome;
    private Button _btnInstall;
    private WrapPanel _wrapIntl;
    private WrapPanel _wrapCn;

    private string _projectDir = "";
    private NodeInfo _node = new NodeInfo();
    private bool _busy;
    private bool _cancelled;
    private Process _currentProcess;

    public SetupApp()
    {
        _localRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HyperContext");
        _homeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hypercontext");
        _logFile = Path.Combine(_localRoot, "setup.log");
        try { Directory.CreateDirectory(_localRoot); } catch { }
    }

    public Window CreateWindow()
    {
        string xaml = LoadXaml();
        _root = (Grid)XamlReader.Parse(xaml);

        _window = new Window();
        _window.Title = "HyperContext Setup";
        _window.Width = 1080;
        _window.Height = 840;
        _window.MinWidth = 940;
        _window.MinHeight = 680;
        _window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        _window.WindowStyle = WindowStyle.None;
        _window.ResizeMode = ResizeMode.CanResize;
        _window.Background = BrushFrom("#F6F7F9");
        _window.FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
        _window.Content = _root;
        _window.Closing += Window_Closing;

        WindowChrome chrome = new WindowChrome();
        chrome.CaptionHeight = 0;
        chrome.ResizeBorderThickness = new Thickness(6);
        chrome.GlassFrameThickness = new Thickness(0);
        chrome.UseAeroCaptionButtons = false;
        WindowChrome.SetWindowChrome(_window, chrome);

        Rect work = SystemParameters.WorkArea;
        _window.Width = Math.Min(_window.Width, work.Width - 40);
        _window.Height = Math.Min(_window.Height, work.Height - 40);

        FindControls();
        WireEvents();
        _txtFooterNote.Text = "安装到 " + _localRoot + "，配置写入 " + _homeDir;
        _window.Loaded += delegate { CheckEnvironment(); };
        return _window;
    }

    private string LoadXaml()
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        string resourceName = "HyperContextSetup.xaml";
        Stream stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (name.EndsWith("HyperContextSetup.xaml", StringComparison.OrdinalIgnoreCase))
                {
                    stream = assembly.GetManifestResourceStream(name);
                    break;
                }
            }
        }
        if (stream == null)
        {
            string local = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "HyperContextSetup.xaml");
            if (File.Exists(local)) return File.ReadAllText(local, Encoding.UTF8);
            throw new FileNotFoundException("Embedded HyperContextSetup.xaml was not found.");
        }
        using (stream)
        {
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
    }

    private void FindControls()
    {
        _txtProject = Find<TextBlock>("TxtProject");
        _txtNode = Find<TextBlock>("TxtNode");
        _txtEngines = Find<TextBlock>("TxtEngines");
        _txtConfig = Find<TextBlock>("TxtConfig");
        _txtProgress = Find<TextBlock>("TxtProgress");
        _txtDone = Find<TextBlock>("TxtDone");
        _statusText = Find<TextBlock>("StatusText");
        _sidebarStatus = Find<TextBlock>("SidebarStatus");
        _txtFooterNote = Find<TextBlock>("TxtFooterNote");
        _dotProject = Find<Ellipse>("DotProject");
        _dotNode = Find<Ellipse>("DotNode");
        _dotEngines = Find<Ellipse>("DotEngines");
        _dotConfig = Find<Ellipse>("DotConfig");
        _txtProxy = Find<TextBox>("TxtProxy");
        _logBox = Find<TextBox>("LogBox");
        _statusPill = Find<Border>("StatusPill");
        _progressTrack = Find<Border>("ProgressTrack");
        _progressFill = Find<Border>("ProgressFill");
        _doneCard = Find<Border>("DoneCard");
        _logCard = Find<Border>("LogCard");
        _btnBrowse = Find<Button>("BtnBrowse");
        _btnDownloadNode = Find<Button>("BtnDownloadNode");
        _btnDownloadProject = Find<Button>("BtnDownloadProject");
        _btnSetupEnv = Find<Button>("BtnSetupEnv");
        _btnRecheck = Find<Button>("BtnRecheck");
        _btnSelectAll = Find<Button>("BtnSelectAll");
        _btnClear = Find<Button>("BtnClear");
        _btnStop = Find<Button>("BtnStop");
        _btnOpenHome = Find<Button>("BtnOpenHome");
        _btnInstall = Find<Button>("BtnInstall");
        _wrapIntl = Find<WrapPanel>("WrapIntl");
        _wrapCn = Find<WrapPanel>("WrapCn");
        _titleBar = Find<Border>("TitleBar");
        _btnMinimize = Find<Button>("BtnMinimize");
        _btnClose = Find<Button>("BtnClose");
    }

    private T Find<T>(string name) where T : class
    {
        object value = _root.FindName(name);
        if (value == null) value = LogicalTreeHelper.FindLogicalNode(_root, name);
        return value as T;
    }

    private void WireEvents()
    {
        _btnBrowse.Click += BtnBrowse_Click;
        _btnRecheck.Click += delegate { CheckEnvironment(); };
        _btnDownloadNode.Click += async delegate { await DownloadNodeAsync(); };
        _btnDownloadProject.Click += async delegate { await DownloadProjectAsync(); };
        _btnSetupEnv.Click += async delegate { await SetupEnvironmentAsync(); };
        _btnInstall.Click += async delegate { await InstallAsync(); };
        _btnStop.Click += delegate { CancelInstall(); };
        _btnOpenHome.Click += delegate { OpenFolder(_homeDir); };
        _btnSelectAll.Click += delegate { SetAllClients(true); };
        _btnClear.Click += delegate { SetAllClients(false); };
        _titleBar.MouseLeftButtonDown += TitleBar_MouseLeftButtonDown;
        _btnMinimize.Click += delegate { _window.WindowState = WindowState.Minimized; };
        _btnClose.Click += delegate { _window.Close(); };
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
        {
            try { _window.DragMove(); } catch { }
        }
    }

    private void Window_Closing(object sender, CancelEventArgs e)
    {
        if (_busy)
        {
            CancelInstall();
        }
    }

    private void BtnBrowse_Click(object sender, RoutedEventArgs e)
    {
        using (System.Windows.Forms.FolderBrowserDialog dialog = new System.Windows.Forms.FolderBrowserDialog())
        {
            dialog.Description = "选择 hypercontext-mode 项目目录";
            if (!string.IsNullOrEmpty(_projectDir)) dialog.SelectedPath = _projectDir;
            if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
            {
                if (IsProjectDir(dialog.SelectedPath))
                {
                    _projectDir = Path.GetFullPath(dialog.SelectedPath);
                    CheckEnvironment();
                }
                else
                {
                    MessageBox.Show("这个目录里没有找到 bin\\hctx.mjs 和 package.json。", "HyperContext Setup",
                        MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            }
        }
    }

    private void CheckEnvironment()
    {
        if (string.IsNullOrEmpty(_projectDir) || !IsProjectDir(_projectDir))
        {
            _projectDir = FindProjectDir();
        }

        if (!string.IsNullOrEmpty(_projectDir))
        {
            _txtProject.Text = _projectDir;
            SetDot(_dotProject, "#16A34A");
        }
        else
        {
            _txtProject.Text = "未找到项目，请浏览或点击“下载项目”";
            SetDot(_dotProject, "#DC2626");
        }

        _node = FindNodeInfo(_projectDir);
        if (_node.Ok)
        {
            _txtNode.Text = _node.Version + "  ·  " + Path.GetFileName(_node.Path);
            _txtNode.ToolTip = _node.Path;
            SetDot(_dotNode, "#16A34A");
        }
        else if (!string.IsNullOrEmpty(_node.Path))
        {
            _txtNode.Text = _node.Version + "（需要 22.18+）  ·  " + Path.GetFileName(_node.Path);
            _txtNode.ToolTip = _node.Path;
            SetDot(_dotNode, "#D97706");
        }
        else
        {
            _txtNode.Text = "未找到 Node.js 22.18+，可点击右侧下载";
            SetDot(_dotNode, "#DC2626");
        }

        bool engines = EnginesBuilt(_projectDir);
        if (engines)
        {
            _txtEngines.Text = "已构建 context-mode + billion-context";
            SetDot(_dotEngines, "#16A34A");
        }
        else
        {
            _txtEngines.Text = "未构建，安装时会自动执行 npm setup/build";
            SetDot(_dotEngines, "#D97706");
        }

        bool config = File.Exists(Path.Combine(_homeDir, "config.json"));
        _txtConfig.Text = config ? "已初始化" : "尚未初始化";
        _txtConfig.ToolTip = _homeDir;
        SetDot(_dotConfig, config ? "#16A34A" : "#94A3B8");

        _btnDownloadProject.Visibility = string.IsNullOrEmpty(_projectDir) ? Visibility.Visible : Visibility.Collapsed;
        _btnDownloadNode.Visibility = _node.Ok ? Visibility.Collapsed : Visibility.Visible;
        _btnSetupEnv.IsEnabled = !_busy && !string.IsNullOrEmpty(_projectDir) && _node.Ok;
        _btnInstall.IsEnabled = !_busy && !string.IsNullOrEmpty(_projectDir) && _node.Ok;

        if (!_busy)
        {
            bool ready = !string.IsNullOrEmpty(_projectDir) && _node.Ok;
            SetStatus(ready ? "就绪" : "需要处理", ready ? "#DCFCE7" : "#FEF3C7", ready ? "#166534" : "#92400E");
            _sidebarStatus.Text = ready ? "环境就绪" : "请先补全环境";
        }
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        _btnInstall.IsEnabled = !busy && !string.IsNullOrEmpty(_projectDir) && _node.Ok;
        _btnSetupEnv.IsEnabled = !busy && !string.IsNullOrEmpty(_projectDir) && _node.Ok;
        _btnRecheck.IsEnabled = !busy;
        _btnBrowse.IsEnabled = !busy;
        _btnSelectAll.IsEnabled = !busy;
        _btnClear.IsEnabled = !busy;
        _btnDownloadNode.IsEnabled = !busy;
        _btnDownloadProject.IsEnabled = !busy;
        _btnStop.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        if (busy)
        {
            _sidebarStatus.Text = "正在安装…";
        }
    }

    private void SetStatus(string text, string background, string foreground)
    {
        _statusText.Text = text;
        _statusPill.Background = BrushFrom(background);
        _statusText.Foreground = BrushFrom(foreground);
    }

    private void SetDot(Ellipse dot, string color)
    {
        dot.Fill = BrushFrom(color);
    }

    private void SetProgress(int done, int total, string text)
    {
        double fraction = total <= 0 ? 0 : (double)done / total;
        if (fraction < 0) fraction = 0;
        if (fraction > 1) fraction = 1;
        double width = _progressTrack.ActualWidth;
        _progressFill.Width = Math.Max(0, width * fraction);
        _txtProgress.Text = text;
    }

    private void Log(string line)
    {
        string stamped = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logFile));
            File.AppendAllText(_logFile, stamped + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
        if (_logBox == null) return;
        _logBox.Dispatcher.BeginInvoke(new Action(delegate
        {
            _logBox.AppendText(line + "\r\n");
            _logBox.ScrollToEnd();
        }));
    }

    private void SetAllClients(bool selected)
    {
        foreach (UIElement child in _wrapIntl.Children)
        {
            CheckBox box = child as CheckBox;
            if (box != null) box.IsChecked = selected;
        }
        foreach (UIElement child in _wrapCn.Children)
        {
            CheckBox box = child as CheckBox;
            if (box != null) box.IsChecked = selected;
        }
    }

    private List<string> GetSelectedClients()
    {
        List<string> result = new List<string>();
        CollectSelected(_wrapIntl, result);
        CollectSelected(_wrapCn, result);
        return result;
    }

    private void CollectSelected(WrapPanel panel, List<string> result)
    {
        foreach (UIElement child in panel.Children)
        {
            CheckBox box = child as CheckBox;
            if (box != null && box.IsChecked == true && box.Tag != null)
            {
                result.Add(box.Tag.ToString());
            }
        }
    }

    private async Task DownloadNodeAsync()
    {
        if (_busy) return;
        SetBusy(true);
        _logCard.Visibility = Visibility.Visible;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("下载 Node.js", "#DBEAFE", "#1D4ED8");
        try
        {
            await DownloadNodeCoreAsync();
            CheckEnvironment();
            SetStatus("Node 已就绪", "#DCFCE7", "#166534");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("下载失败", "#FEE2E2", "#991B1B");
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task<bool> EnsureNodeAsync()
    {
        if (_node.Ok) return true;
        await DownloadNodeCoreAsync();
        _node = FindNodeInfo(_projectDir);
        return _node.Ok;
    }

    private async Task DownloadNodeCoreAsync()
    {
        string zip = Path.Combine(Path.GetTempPath(), "hypercontext-node-win-x64.zip");
        string temp = Path.Combine(Path.GetTempPath(), "hypercontext-node-" + Guid.NewGuid().ToString("N"));
        try
        {
            Log("下载 Node.js 24 LTS…");
            await DownloadFileAsync(NodeZipUrl, zip);
            Log("解压 Node.js…");
            Directory.CreateDirectory(temp);
            ZipFile.ExtractToDirectory(zip, temp);
            string nodeExe = FindFile(temp, "node.exe");
            if (nodeExe == null) throw new Exception("Node 压缩包里没有 node.exe");
            string sourceDir = Path.GetDirectoryName(nodeExe);
            string dest = Path.Combine(_localRoot, "node");
            if (Directory.Exists(dest)) Directory.Delete(dest, true);
            CopyDirectory(sourceDir, dest);
            _node = new NodeInfo();
            _node.Path = Path.Combine(dest, "node.exe");
            _node.Version = GetNodeVersion(_node.Path);
            Version version;
            _node.Ok = TryParseVersion(_node.Version, out version) && IsSupportedNode(version);
            Log("Node 已安装到 " + dest);
        }
        finally
        {
            TryDeleteFile(zip);
            TryDeleteDirectory(temp);
        }
    }

    private async Task DownloadProjectAsync()
    {
        if (_busy) return;
        SetBusy(true);
        _logCard.Visibility = Visibility.Visible;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("下载项目", "#DBEAFE", "#1D4ED8");
        try
        {
            await DownloadProjectCoreAsync();
            CheckEnvironment();
            SetStatus("项目已下载", "#DCFCE7", "#166534");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("下载失败", "#FEE2E2", "#991B1B");
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task DownloadProjectCoreAsync()
    {
        string zip = Path.Combine(Path.GetTempPath(), "hypercontext-mode-main.zip");
        string temp = Path.Combine(Path.GetTempPath(), "hypercontext-project-" + Guid.NewGuid().ToString("N"));
        try
        {
            Log("下载 HyperContext Mode 源码…");
            await DownloadFileAsync(ProjectZipUrl, zip);
            Log("解压项目…");
            Directory.CreateDirectory(temp);
            ZipFile.ExtractToDirectory(zip, temp);
            string project = FindProjectRoot(temp);
            if (project == null) throw new Exception("下载包里没有找到项目根目录");
            string dest = Path.Combine(_localRoot, "app");
            if (Directory.Exists(dest)) Directory.Delete(dest, true);
            CopyDirectory(project, dest);
            _projectDir = dest;
            Log("项目已安装到 " + dest);
        }
        finally
        {
            TryDeleteFile(zip);
            TryDeleteDirectory(temp);
        }
    }

    private async Task DownloadFileAsync(string url, string destination)
    {
        string proxy = _txtProxy.Text == null ? "" : _txtProxy.Text.Trim();
        HttpClientHandler handler = new HttpClientHandler();
        if (!string.IsNullOrEmpty(proxy))
        {
            handler.Proxy = new WebProxy(proxy);
            handler.UseProxy = true;
        }
        using (HttpClient client = new HttpClient(handler))
        {
            client.Timeout = TimeSpan.FromMinutes(20);
            using (HttpResponseMessage response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
            {
                response.EnsureSuccessStatusCode();
                long total = response.Content.Headers.ContentLength.HasValue ? response.Content.Headers.ContentLength.Value : 0;
                using (Stream input = await response.Content.ReadAsStreamAsync())
                using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[81920];
                    long readTotal = 0;
                    int lastPercent = -1;
                    int read;
                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length)) > 0)
                    {
                        await output.WriteAsync(buffer, 0, read);
                        readTotal += read;
                        if (total > 0)
                        {
                            int percent = (int)(readTotal * 100 / total);
                            if (percent >= lastPercent + 5)
                            {
                                lastPercent = percent;
                                Log("  下载进度 " + percent + "%");
                            }
                        }
                    }
                }
            }
        }
    }

    private async Task SetupEnvironmentAsync()
    {
        if (_busy) return;
        SetBusy(true);
        _logCard.Visibility = Visibility.Visible;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("准备环境", "#DBEAFE", "#1D4ED8");
        try
        {
            if (string.IsNullOrEmpty(_projectDir)) throw new Exception("请先选择项目目录或下载项目");
            if (!await EnsureNodeAsync()) throw new Exception("Node.js 不可用");
            await RunNpmAsync("install --ignore-scripts --no-audit --no-fund", "安装控制面依赖");
            int code = await RunNpmAsync("run setup:all", "安装并构建两个引擎");
            if (code != 0)
            {
                Log("setup:all 失败，尝试分步安装…");
                code = await RunNpmAsync("run setup:engines", "安装引擎依赖");
                if (code == 0) code = await RunNpmAsync("run build:engines", "构建引擎");
            }
            if (code != 0) throw new Exception("引擎构建失败，请查看日志");
            await RunHctxAsync("init", "初始化统一配置");
            CheckEnvironment();
            SetStatus("环境就绪", "#DCFCE7", "#166534");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("环境安装失败", "#FEE2E2", "#991B1B");
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task InstallAsync()
    {
        if (_busy) return;
        List<string> selected = GetSelectedClients();
        if (selected.Count == 0)
        {
            MessageBox.Show("请至少选择一个客户端。", "HyperContext Setup", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (string.IsNullOrEmpty(_projectDir))
        {
            MessageBox.Show("请先选择项目目录或下载项目。", "HyperContext Setup", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        _cancelled = false;
        _logBox.Clear();
        _logCard.Visibility = Visibility.Visible;
        _doneCard.Visibility = Visibility.Collapsed;
        _btnOpenHome.Visibility = Visibility.Collapsed;
        SetBusy(true);
        SetStatus("安装中", "#DBEAFE", "#1D4ED8");

        int total = selected.Count + 4;
        int done = 0;
        try
        {
            if (!await EnsureNodeAsync()) throw new Exception("Node.js 不可用");
            if (!Directory.Exists(Path.Combine(_projectDir, "node_modules")))
            {
                int code = await RunNpmAsync("install --ignore-scripts --no-audit --no-fund", "安装控制面依赖");
                if (code != 0) throw new Exception("npm install 失败");
            }
            done++;
            SetProgress(done, total, "构建两个引擎");
            if (!EnginesBuilt(_projectDir))
            {
                int code = await RunNpmAsync("run setup:all", "安装并构建两个引擎");
                if (code != 0)
                {
                    Log("setup:all 失败，尝试分步安装…");
                    code = await RunNpmAsync("run setup:engines", "安装引擎依赖");
                    if (code == 0) code = await RunNpmAsync("run build:engines", "构建引擎");
                }
                if (code != 0) throw new Exception("引擎构建失败，请查看日志");
            }

            done++;
            SetProgress(done, total, "初始化统一配置");
            int initCode = await RunHctxAsync("init", "初始化统一配置");
            if (initCode != 0) throw new Exception("hctx init 失败");

            foreach (string id in selected)
            {
                if (_cancelled) throw new OperationCanceledException();
                done++;
                string label = ClientNames.ContainsKey(id) ? ClientNames[id] : id;
                SetProgress(done, total, "配置 " + label);
                await ConfigureClientAsync(id);
            }

            done++;
            SetProgress(done, total, "启动压缩代理");
            await RunHctxAsync("start", "启动压缩代理");
            done++;
            SetProgress(done, total, "运行统一体检");
            await RunHctxAsync("doctor", "运行统一体检");
            await RunHctxAsync("status", "读取统一状态");

            SetProgress(total, total, "完成");
            _doneCard.Visibility = Visibility.Visible;
            _btnOpenHome.Visibility = Visibility.Visible;
            _txtDone.Text = BuildDoneText(selected);
            SetStatus("完成", "#DCFCE7", "#166534");
            _sidebarStatus.Text = "安装完成";
        }
        catch (OperationCanceledException)
        {
            Log("安装已停止。");
            SetStatus("已停止", "#FEF3C7", "#92400E");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("安装出错", "#FEE2E2", "#991B1B");
        }
        finally
        {
            SetBusy(false);
            CheckEnvironment();
            if (_doneCard.Visibility == Visibility.Visible)
            {
                SetStatus("完成", "#DCFCE7", "#166534");
                _sidebarStatus.Text = "安装完成";
            }
        }
    }

    private string BuildDoneText(List<string> selected)
    {
        List<string> labels = new List<string>();
        foreach (string id in selected)
        {
            labels.Add(ClientNames.ContainsKey(id) ? ClientNames[id] : id);
        }
        return "完成。已处理：" + string.Join("、", labels.ToArray()) +
               "。Qoder / Zcode 用 hctx launch <客户端> 启动压缩；WorkBuddy 需要把 mcp.json 加入客户端并把 base URL 指向本地代理；Claude Code / Codex 的 MCP 如未自动注册，请使用工件目录中的 mcp.json。";
    }

    private async Task ConfigureClientAsync(string id)
    {
        bool installed = IsClientInstalled(id);
        string label = ClientNames.ContainsKey(id) ? ClientNames[id] : id;
        string extra = "";
        if (!installed)
        {
            Log("未检测到 " + label + "，只生成工件，不修改客户端配置。");
        }
        else if (id == "claude-code")
        {
            extra = " --hooks";
        }
        else if (id == "codex" || id == "dsh")
        {
            extra = " --plugin";
        }

        int code = await RunHctxAsync("setup " + id + extra, "配置 " + label + (installed ? "" : "（仅工件）"));
        if (code != 0)
        {
            Log("配置 " + label + " 返回 " + code + "，继续下一个。");
        }

        if (id == "codex" && installed)
        {
            EnsureCodexMcp();
        }
    }

    private bool IsClientInstalled(string id)
    {
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (id == "claude-code")
        {
            string configDir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
            if (!string.IsNullOrEmpty(configDir) && Directory.Exists(configDir)) return true;
            return Directory.Exists(Path.Combine(user, ".claude")) || WhereExists("claude");
        }
        if (id == "codex") return Directory.Exists(Path.Combine(user, ".codex")) || WhereExists("codex");
        if (id == "dsh") return Directory.Exists(Path.Combine(user, ".dsh")) || WhereExists("dsh");
        if (id == "qoder-intl" || id == "qoder-cn")
        {
            return Directory.Exists(Path.Combine(appData, "Qoder")) ||
                   Directory.Exists(Path.Combine(localAppData, "Qoder")) ||
                   Directory.Exists(Path.Combine(user, ".qoder")) ||
                   WhereExists("qoder");
        }
        if (id == "workbuddy-intl" || id == "workbuddy-cn")
        {
            return Directory.Exists(Path.Combine(appData, "WorkBuddy")) ||
                   Directory.Exists(Path.Combine(localAppData, "WorkBuddy")) ||
                   Directory.Exists(Path.Combine(user, ".workbuddy")) ||
                   WhereExists("workbuddy");
        }
        if (id == "zcode")
        {
            return Directory.Exists(Path.Combine(user, ".zcode")) ||
                   Directory.Exists(Path.Combine(appData, "zcode")) ||
                   WhereExists("zcode");
        }
        return false;
    }

    private void EnsureCodexMcp()
    {
        try
        {
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dir = Path.Combine(user, ".codex");
            if (!Directory.Exists(dir)) return;
            string config = Path.Combine(dir, "config.toml");
            string existing = File.Exists(config) ? File.ReadAllText(config, Encoding.UTF8) : "";
            if (existing.IndexOf("[mcp_servers.hypercontext]", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Log("Codex config.toml 已有 hypercontext MCP 条目。");
                return;
            }
            if (File.Exists(config))
            {
                File.Copy(config, config + ".hypercontext.bak", true);
            }
            string hctx = Path.Combine(_projectDir, "bin", "hctx.mjs").Replace("\\", "/");
            string home = _homeDir.Replace("\\", "/");
            StringBuilder sb = new StringBuilder(existing);
            if (sb.Length > 0 && sb[sb.Length - 1] != '\n') sb.AppendLine();
            sb.AppendLine();
            sb.AppendLine("[mcp_servers.hypercontext]");
            sb.AppendLine("command = \"node\"");
            sb.AppendLine("args = [\"" + TomlEscape(hctx) + "\", \"mcp\", \"--client\", \"codex\"]");
            sb.AppendLine("env = { HYPERCONTEXT_HOME = \"" + TomlEscape(home) + "\" }");
            File.WriteAllText(config, sb.ToString(), new UTF8Encoding(false));
            Log("已写入 Codex 统一 MCP 配置（备份 config.toml.hypercontext.bak）。");
        }
        catch (Exception ex)
        {
            Log("写入 Codex MCP 失败：" + ex.Message);
        }
    }

    private static string TomlEscape(string value)
    {
        return value.Replace("\\", "/").Replace("\"", "\\\"");
    }

    private async Task<int> RunNpmAsync(string args, string label)
    {
        string nodeDir = Path.GetDirectoryName(_node.Path);
        string npm = Path.Combine(nodeDir, "npm.cmd");
        string command;
        if (File.Exists(npm))
        {
            command = "\"" + npm + "\" " + args;
        }
        else
        {
            command = "npm " + args;
        }
        Dictionary<string, string> env = BuildBaseEnv();
        return await RunProcessAsync("cmd.exe", "/d /s /c \"" + command + "\"", _projectDir, env, label);
    }

    private async Task<int> RunHctxAsync(string args, string label)
    {
        string hctx = Path.Combine(_projectDir, "bin", "hctx.mjs");
        Dictionary<string, string> env = BuildBaseEnv();
        env["HYPERCONTEXT_HOME"] = _homeDir;
        return await RunProcessAsync(_node.Path, "\"" + hctx + "\" " + args, _projectDir, env, label);
    }

    private Dictionary<string, string> BuildBaseEnv()
    {
        Dictionary<string, string> env = new Dictionary<string, string>();
        string nodeDir = Path.GetDirectoryName(_node.Path);
        string path = Environment.GetEnvironmentVariable("PATH");
        env["PATH"] = nodeDir + ";" + (path == null ? "" : path);
        string proxy = _txtProxy.Text == null ? "" : _txtProxy.Text.Trim();
        if (!string.IsNullOrEmpty(proxy))
        {
            env["HTTP_PROXY"] = proxy;
            env["HTTPS_PROXY"] = proxy;
            env["NO_PROXY"] = "127.0.0.1,localhost";
        }
        env["CI"] = "1";
        return env;
    }

    private async Task<int> RunProcessAsync(string fileName, string arguments, string workingDir,
        Dictionary<string, string> environment, string label)
    {
        if (_cancelled) throw new OperationCanceledException();
        Log("> " + label);
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = fileName;
        info.Arguments = arguments;
        info.WorkingDirectory = workingDir;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        if (environment != null)
        {
            foreach (KeyValuePair<string, string> pair in environment)
            {
                info.EnvironmentVariables[pair.Key] = pair.Value;
            }
        }

        using (Process process = new Process())
        {
            process.StartInfo = info;
            TaskCompletionSource<int> completion = new TaskCompletionSource<int>();
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("  " + e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("  " + e.Data);
            };
            process.Exited += delegate(object sender, EventArgs e)
            {
                try { completion.TrySetResult(process.ExitCode); }
                catch { completion.TrySetResult(1); }
            };
            try
            {
                process.Start();
                _currentProcess = process;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Log("启动失败：" + ex.Message);
                return 1;
            }
            int code = await completion.Task;
            _currentProcess = null;
            if (code != 0) Log("  (exit " + code + ")");
            return code;
        }
    }

    private void CancelInstall()
    {
        _cancelled = true;
        Process process = _currentProcess;
        if (process != null)
        {
            try { process.Kill(); } catch { }
        }
    }

    private void OpenFolder(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            Process.Start("explorer.exe", "\"" + folder + "\"");
        }
        catch (Exception ex)
        {
            MessageBox.Show("打开目录失败：" + ex.Message, "HyperContext Setup", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private bool EnginesBuilt(string projectDir)
    {
        if (string.IsNullOrEmpty(projectDir)) return false;
        return File.Exists(Path.Combine(projectDir, "engines", "context-mode", "build", "server.js")) &&
               File.Exists(Path.Combine(projectDir, "engines", "billion-context", "dist", "index.js"));
    }

    private NodeInfo FindNodeInfo(string projectDir)
    {
        List<string> candidates = new List<string>();
        if (!string.IsNullOrEmpty(projectDir))
        {
            candidates.Add(Path.Combine(projectDir, ".tools", "node", "node.exe"));
        }
        candidates.Add(Path.Combine(_localRoot, "node", "node.exe"));
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PATH")) == false)
        {
            string where = WhereExe("node");
            if (!string.IsNullOrEmpty(where)) candidates.Add(where);
        }

        NodeInfo result = new NodeInfo();
        foreach (string candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate) || !File.Exists(candidate)) continue;
            string version = GetNodeVersion(candidate);
            result.Path = candidate;
            result.Version = version;
            Version parsed;
            result.Ok = TryParseVersion(version, out parsed) && IsSupportedNode(parsed);
            return result;
        }
        return result;
    }

    private static bool IsSupportedNode(Version version)
    {
        if (version == null) return false;
        return version.Major > 22 || (version.Major == 22 && version.Minor >= 18);
    }

    private static bool TryParseVersion(string text, out Version version)
    {
        version = null;
        if (string.IsNullOrEmpty(text)) return false;
        string trimmed = text.Trim();
        if (trimmed.Length > 0 && (trimmed[0] == 'v' || trimmed[0] == 'V')) trimmed = trimmed.Substring(1);
        int newline = trimmed.IndexOfAny(new char[] { '\r', '\n' });
        if (newline >= 0) trimmed = trimmed.Substring(0, newline);
        return Version.TryParse(trimmed, out version);
    }

    private static string GetNodeVersion(string nodeExe)
    {
        string output = RunCapture(nodeExe, "-v", 5000);
        return output == null ? "" : output.Trim();
    }

    private string FindProjectDir()
    {
        List<string> candidates = new List<string>();
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        candidates.Add(baseDir);
        candidates.Add(Path.GetDirectoryName(baseDir.TrimEnd('\\')));
        candidates.Add(Path.GetDirectoryName(Path.GetDirectoryName(baseDir.TrimEnd('\\'))));
        candidates.Add(Path.Combine(_localRoot, "app"));
        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrEmpty(candidate) && IsProjectDir(candidate)) return Path.GetFullPath(candidate);
        }
        return "";
    }

    private static bool IsProjectDir(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return false;
        try
        {
            return File.Exists(Path.Combine(dir, "bin", "hctx.mjs")) &&
                   File.Exists(Path.Combine(dir, "package.json"));
        }
        catch
        {
            return false;
        }
    }

    private static string WhereExe(string name)
    {
        string output = RunCapture("cmd.exe", "/d /s /c where " + name, 5000);
        if (string.IsNullOrEmpty(output)) return "";
        string[] lines = output.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        return lines.Length > 0 ? lines[0].Trim() : "";
    }

    private static bool WhereExists(string name)
    {
        string path = WhereExe(name);
        return !string.IsNullOrEmpty(path) && File.Exists(path);
    }

    private static string RunCapture(string fileName, string arguments, int timeoutMs)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = fileName;
            info.Arguments = arguments;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            using (Process process = Process.Start(info))
            {
                string output = process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    return "";
                }
                return output;
            }
        }
        catch
        {
            return "";
        }
    }

    private static string FindFile(string root, string fileName)
    {
        string[] files = Directory.GetFiles(root, fileName, SearchOption.AllDirectories);
        return files.Length > 0 ? files[0] : null;
    }

    private static string FindProjectRoot(string root)
    {
        string[] packages = Directory.GetFiles(root, "package.json", SearchOption.AllDirectories);
        foreach (string package in packages)
        {
            string dir = Path.GetDirectoryName(package);
            if (File.Exists(Path.Combine(dir, "bin", "hctx.mjs"))) return dir;
        }
        return null;
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
        {
            string target = Path.Combine(destination, Path.GetFileName(file));
            File.Copy(file, target, true);
        }
        foreach (string dir in Directory.GetDirectories(source))
        {
            string target = Path.Combine(destination, Path.GetFileName(dir));
            CopyDirectory(dir, target);
        }
    }

    private static void TryDeleteFile(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch { }
    }

    private static void TryDeleteDirectory(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }

    private static Brush BrushFrom(string hex)
    {
        return new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
    }

    // ----- Self test -----

    private static int SelfTest()
    {
        StringBuilder sb = new StringBuilder();
        int code = 0;
        try
        {
            string localRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HyperContext");
            string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hypercontext");
            sb.AppendLine("exe=" + AppDomain.CurrentDomain.BaseDirectory);
            sb.AppendLine("localRoot=" + localRoot);
            sb.AppendLine("home=" + home);

            string project = "";
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string[] candidates = new string[]
            {
                baseDir,
                Path.GetDirectoryName(baseDir.TrimEnd('\\')),
                Path.GetDirectoryName(Path.GetDirectoryName(baseDir.TrimEnd('\\'))),
                Path.Combine(localRoot, "app")
            };
            foreach (string candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate) && IsProjectDir(candidate))
                {
                    project = Path.GetFullPath(candidate);
                    break;
                }
            }
            sb.AppendLine("project=" + project);
            if (string.IsNullOrEmpty(project)) code = 1;

            string nodeExe = Path.Combine(project, ".tools", "node", "node.exe");
            if (!File.Exists(nodeExe)) nodeExe = Path.Combine(localRoot, "node", "node.exe");
            if (!File.Exists(nodeExe)) nodeExe = WhereExe("node");
            sb.AppendLine("node=" + nodeExe);
            string version = string.IsNullOrEmpty(nodeExe) ? "" : GetNodeVersion(nodeExe);
            sb.AppendLine("nodeVersion=" + version);
            Version parsed;
            bool nodeOk = TryParseVersion(version, out parsed) && IsSupportedNode(parsed);
            sb.AppendLine("nodeOk=" + nodeOk);
            if (!nodeOk) code = 1;

            bool engines = !string.IsNullOrEmpty(project) &&
                File.Exists(Path.Combine(project, "engines", "context-mode", "build", "server.js")) &&
                File.Exists(Path.Combine(project, "engines", "billion-context", "dist", "index.js"));
            sb.AppendLine("engines=" + engines);

            Assembly assembly = Assembly.GetExecutingAssembly();
            bool xaml = false;
            string xamlText = null;
            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (name.EndsWith("HyperContextSetup.xaml", StringComparison.OrdinalIgnoreCase))
                {
                    xaml = true;
                    using (Stream stream = assembly.GetManifestResourceStream(name))
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        xamlText = reader.ReadToEnd();
                    }
                    break;
                }
            }
            sb.AppendLine("xaml=" + xaml);
            if (!xaml) code = 1;
            if (xamlText != null)
            {
                try
                {
                    XamlReader.Parse(xamlText);
                    sb.AppendLine("xamlParse=ok");
                }
                catch (Exception ex)
                {
                    sb.AppendLine("xamlParse=error");
                    sb.AppendLine(ex.ToString());
                    code = 1;
                }
            }
        }
        catch (Exception ex)
        {
            sb.AppendLine("error=" + ex.ToString());
            code = 1;
        }

        string report = Path.Combine(Path.GetTempPath(), "hypercontext-setup-selftest.txt");
        File.WriteAllText(report, sb.ToString(), Encoding.UTF8);
        return code;
    }

    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
        {
            Environment.Exit(SelfTest());
            return;
        }

        try
        {
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            SetupApp setup = new SetupApp();
            app.Run(setup.CreateWindow());
        }
        catch (Exception ex)
        {
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "hypercontext-setup-crash.txt"),
                    ex.ToString(), Encoding.UTF8);
            }
            catch { }
            MessageBox.Show("安装器启动失败：" + ex.Message + "\n\n日志：" +
                Path.Combine(Path.GetTempPath(), "hypercontext-setup-crash.txt"),
                "HyperContext Setup", MessageBoxButton.OK, MessageBoxImage.Error);
            Environment.Exit(1);
        }
    }
}
