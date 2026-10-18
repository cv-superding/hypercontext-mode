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
[assembly: AssemblyVersion("0.1.3.0")]
[assembly: AssemblyFileVersion("0.1.3.0")]

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

    private const string InstallerVersion = "0.1.3";

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
    private StackPanel _panelEnv;
    private StackPanel _panelClients;
    private StackPanel _panelInstall;
    private Button _btnStepEnv;
    private Button _btnStepClients;
    private Button _btnStepInstall;
    private Button _btnBack;
    private TextBlock _txtHeroTitle;
    private TextBlock _txtHeroSubtitle;
    private TextBlock _txtHeroEyebrow;
    private Border _chipEnv;
    private Border _chipClients;
    private Border _chipInstall;
    private TextBlock _chipEnvText;
    private TextBlock _chipClientsText;
    private TextBlock _chipInstallText;
    private Button _btnTabAll;
    private Button _btnTabIntl;
    private Button _btnTabCn;
    private TextBlock _lblIntl;
    private TextBlock _lblCn;
    private ScrollViewer _contentScroll;
    private readonly Dictionary<string, Border> _badges = new Dictionary<string, Border>();
    private readonly Dictionary<string, string> _clientStatus = new Dictionary<string, string>();
    private readonly Dictionary<string, bool> _detectedCache = new Dictionary<string, bool>();
    private int _step = 1;

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
    private Border _planCard;
    private Border _installedCard;
    private TextBlock _txtInstalled;
    private TextBlock _txtInstalledDetail;
    private Button _btnRedo;
    private Button _btnUninstall;
    private bool _alreadyInstalled;
    private bool _installSucceeded;
    private string _installedVersion = "";
    private string _installedApp = "";
    private readonly List<string> _installedClients = new List<string>();
    private Button _btnBrowse;
    private Button _btnDownloadNode;
    private Button _btnDownloadProject;
    private Button _btnSetupEnv;
    private Button _btnRecheck;
    private TextBlock _txtEnvHint;
    private Button _btnSelectAll;
    private Button _btnClear;
    private Button _btnStop;
    private Button _btnOpenHome;
    private Button _btnInstall;
    private Panel _wrapIntl;
    private Panel _wrapCn;

    public int InitialStep = 1;

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
        _window.Width = 1000;
        _window.Height = 660;
        _window.MinWidth = 880;
        _window.MinHeight = 560;
        _window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        _window.WindowStyle = WindowStyle.None;
        _window.ResizeMode = ResizeMode.CanResize;
        _window.AllowsTransparency = true;
        _window.Background = Brushes.Transparent;
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
        LoadInstallState();
        WireEvents();
        _txtFooterNote.Text = "安装到 " + _localRoot + "，配置写入 " + _homeDir;
        ShowStep(1);
        if (InitialStep > 1) ShowStep(InitialStep);
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
        _planCard = Find<Border>("PlanCard");

        _installedCard = Find<Border>("InstalledCard");
        _txtInstalled = Find<TextBlock>("TxtInstalled");
        _txtInstalledDetail = Find<TextBlock>("TxtInstalledDetail");
        _btnRedo = Find<Button>("BtnRedo");
        _btnUninstall = Find<Button>("BtnUninstall");
        _btnBrowse = Find<Button>("BtnBrowse");
        _btnDownloadNode = Find<Button>("BtnDownloadNode");
        _btnDownloadProject = Find<Button>("BtnDownloadProject");
        _btnSetupEnv = Find<Button>("BtnSetupEnv");
        _btnRecheck = Find<Button>("BtnRecheck");
        _txtEnvHint = Find<TextBlock>("TxtEnvHint");
        _btnSelectAll = Find<Button>("BtnSelectAll");
        _btnClear = Find<Button>("BtnClear");
        _btnStop = Find<Button>("BtnStop");
        _btnOpenHome = Find<Button>("BtnOpenHome");
        _btnInstall = Find<Button>("BtnInstall");
        _wrapIntl = Find<Panel>("WrapIntl");
        _wrapCn = Find<Panel>("WrapCn");
        _titleBar = Find<Border>("TitleBar");
        _btnMinimize = Find<Button>("BtnMinimize");
        _btnClose = Find<Button>("BtnClose");
        _panelEnv = Find<StackPanel>("PanelEnv");
        _panelClients = Find<StackPanel>("PanelClients");
        _panelInstall = Find<StackPanel>("PanelInstall");
        _btnStepEnv = Find<Button>("BtnStepEnv");
        _btnStepClients = Find<Button>("BtnStepClients");
        _btnStepInstall = Find<Button>("BtnStepInstall");
        _btnBack = Find<Button>("BtnBack");
        _txtHeroTitle = Find<TextBlock>("TxtHeroTitle");
        _txtHeroSubtitle = Find<TextBlock>("TxtHeroSubtitle");
        _txtHeroEyebrow = Find<TextBlock>("TxtHeroEyebrow");
        _chipEnv = Find<Border>("ChipEnv");
        _chipClients = Find<Border>("ChipClients");
        _chipInstall = Find<Border>("ChipInstall");
        _chipEnvText = Find<TextBlock>("ChipEnvText");
        _chipClientsText = Find<TextBlock>("ChipClientsText");
        _chipInstallText = Find<TextBlock>("ChipInstallText");
        _btnTabAll = Find<Button>("BtnTabAll");
        _btnTabIntl = Find<Button>("BtnTabIntl");
        _btnTabCn = Find<Button>("BtnTabCn");
        _lblIntl = Find<TextBlock>("LblIntl");
        _lblCn = Find<TextBlock>("LblCn");
        _contentScroll = Find<ScrollViewer>("ContentScroll");
        _badges["claude-code"] = Find<Border>("BadgeClaudeCode");
        _badges["codex"] = Find<Border>("BadgeCodex");
        _badges["qoder-intl"] = Find<Border>("BadgeQoderIntl");
        _badges["workbuddy-intl"] = Find<Border>("BadgeWorkBuddyIntl");
        _badges["qoder-cn"] = Find<Border>("BadgeQoderCn");
        _badges["workbuddy-cn"] = Find<Border>("BadgeWorkBuddyCn");
        _badges["dsh"] = Find<Border>("BadgeDsh");
        _badges["zcode"] = Find<Border>("BadgeZcode");
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
        _btnRecheck.Click += async delegate
        {
            if (_busy) return;
            _btnRecheck.IsEnabled = false;
            SetStatus("检查中", "#ECEEF1", "#68707A");
            if (_txtEnvHint != null) _txtEnvHint.Text = "正在重新检查…";
            await Task.Delay(400);
            CheckEnvironment();
            _btnRecheck.IsEnabled = !_busy;
        };
        _btnDownloadNode.Click += async delegate { await DownloadNodeAsync(); };
        _btnDownloadProject.Click += async delegate { await DownloadProjectAsync(); };
        _btnSetupEnv.Click += async delegate { await SetupEnvironmentAsync(); };
        _btnInstall.Click += async delegate
        {
            if (_step < 3) { ShowStep(_step + 1); return; }
            if (_installSucceeded || _alreadyInstalled) { _window.Close(); return; }
            await InstallAsync();
        };
        _btnStop.Click += delegate { CancelInstall(); };
        _btnOpenHome.Click += delegate { OpenFolder(_homeDir); };
        _btnSelectAll.Click += delegate { SetAllClients(true); };
        _btnClear.Click += delegate { SetAllClients(false); };

        _btnRedo.Click += async delegate { await InstallAsync(); };
        _btnUninstall.Click += async delegate { await UninstallAsync(); };
        _btnTabAll.Click += delegate { ShowClientTab("all"); };
        _btnTabIntl.Click += delegate { ShowClientTab("intl"); };
        _btnTabCn.Click += delegate { ShowClientTab("cn"); };
        _btnStepEnv.Click += delegate { ShowStep(1); };
        _btnStepClients.Click += delegate { ShowStep(2); };
        _btnStepInstall.Click += delegate { ShowStep(3); };
        _btnBack.Click += delegate { if (_step > 1) ShowStep(_step - 1); };
        _titleBar.MouseLeftButtonDown += TitleBar_MouseLeftButtonDown;
        _btnMinimize.Click += delegate { _window.WindowState = WindowState.Minimized; };
        _btnClose.Click += delegate { _window.Close(); };
    }

    private void ShowStep(int step)
    {
        if (step < 1) step = 1;
        if (step > 3) step = 3;
        _step = step;
        _panelEnv.Visibility = step == 1 ? Visibility.Visible : Visibility.Collapsed;
        _panelClients.Visibility = step == 2 ? Visibility.Visible : Visibility.Collapsed;
        _panelInstall.Visibility = step == 3 ? Visibility.Visible : Visibility.Collapsed;
        _btnStepEnv.Tag = step == 1 ? "active" : null;
        _btnStepClients.Tag = step == 2 ? "active" : null;
        _btnStepInstall.Tag = step == 3 ? "active" : null;
        PaintChip(_chipEnv, _chipEnvText, step == 1);
        PaintChip(_chipClients, _chipClientsText, step == 2);
        PaintChip(_chipInstall, _chipInstallText, step == 3);
        _btnBack.Visibility = step == 1 ? Visibility.Collapsed : Visibility.Visible;
        RefreshInstallStateUi();
        if (step == 1)
        {
            _txtHeroEyebrow.Text = "步骤 01 / 03";
            _txtHeroTitle.Text = "环境检查";
            _txtHeroSubtitle.Text = "确认 Node、引擎和配置目录都就绪。";
        }
        else if (step == 2)
        {
            _txtHeroEyebrow.Text = "步骤 02 / 03";
            _txtHeroTitle.Text = "选择客户端";
            _txtHeroSubtitle.Text = "国内版与国际版分开管理；未检测到的客户端只生成工件。";
        }
        else
        {
            _txtHeroEyebrow.Text = "步骤 03 / 03";
            _txtHeroTitle.Text = "安装与配置";
            _txtHeroSubtitle.Text = "安装依赖、构建引擎、写入工件并启动代理。";
        }
        if (_contentScroll != null) _contentScroll.ScrollToVerticalOffset(0);
    }

    private void PaintChip(Border chip, TextBlock label, bool active)
    {
        if (chip == null || label == null) return;
        chip.Background = BrushFrom(active ? "#FFEBE7" : "#EEF0F2");
        label.Foreground = BrushFrom(active ? "#A3483A" : "#6B737C");
    }

    private void ShowClientTab(string mode)
    {
        bool all = mode == "all";
        bool intl = mode == "intl" || all;
        bool cn = mode == "cn" || all;
        if (_wrapIntl != null) _wrapIntl.Visibility = intl ? Visibility.Visible : Visibility.Collapsed;
        if (_wrapCn != null) _wrapCn.Visibility = cn ? Visibility.Visible : Visibility.Collapsed;
        if (_lblIntl != null) _lblIntl.Visibility = intl ? Visibility.Visible : Visibility.Collapsed;
        if (_lblCn != null) _lblCn.Visibility = cn ? Visibility.Visible : Visibility.Collapsed;
        if (_btnTabAll != null) _btnTabAll.Tag = all ? "active" : null;
        if (_btnTabIntl != null) _btnTabIntl.Tag = mode == "intl" ? "active" : null;
        if (_btnTabCn != null) _btnTabCn.Tag = mode == "cn" ? "active" : null;
    }

    private void RefreshInstallStateUi()
    {
        bool settled = _installSucceeded || _alreadyInstalled;
        bool showInstalled = _step == 3 && settled && !_installSucceeded;
        if (_installedCard != null) _installedCard.Visibility = showInstalled ? Visibility.Visible : Visibility.Collapsed;
        bool showProgress = _installSucceeded || !_alreadyInstalled;
        if (_progressTrack != null) _progressTrack.Visibility = showProgress ? Visibility.Visible : Visibility.Collapsed;
        if (_progressFill != null) _progressFill.Visibility = showProgress ? Visibility.Visible : Visibility.Collapsed;
        if (_txtProgress != null) _txtProgress.Visibility = showProgress ? Visibility.Visible : Visibility.Collapsed;
        if (_btnRedo != null) _btnRedo.Visibility = showInstalled ? Visibility.Visible : Visibility.Collapsed;
        if (_btnUninstall != null) _btnUninstall.Visibility = showInstalled ? Visibility.Visible : Visibility.Collapsed;
        if (_planCard != null) _planCard.Visibility = _step == 3 && !settled ? Visibility.Visible : Visibility.Collapsed;
        if (_step != 3)
        {
            _btnInstall.Content = "下一步";
            return;
        }
        _btnInstall.Content = settled ? "完成并关闭" : "开始安装";
        if (_installSucceeded) _btnOpenHome.Visibility = Visibility.Visible;
        if (showInstalled)
        {
            _txtInstalled.Text = string.IsNullOrEmpty(_installedVersion)
                ? "检测到本机已安装 HyperContext。"
                : "检测到本机已安装 HyperContext v" + _installedVersion + "。";
            string clients = _installedClients.Count > 0 ? _installedClients.Count + " 个客户端已配置" : "客户端配置未记录";
            _txtInstalledDetail.Text = "配置目录 " + _homeDir + " · " + clients + "。无需重装，直接关闭即可；环境异常时再点修复。";
        }
    }

    private string ReadPackageVersion(string dir)
    {
        try
        {
            if (string.IsNullOrEmpty(dir)) return "";
            string file = Path.Combine(dir, "package.json");
            if (!File.Exists(file)) return "";
            string text = File.ReadAllText(file, Encoding.UTF8);
            int key = text.IndexOf("\"version\"", StringComparison.Ordinal);
            if (key < 0) return "";
            int colon = text.IndexOf(':', key);
            if (colon < 0) return "";
            int open = text.IndexOf('"', colon + 1);
            if (open < 0) return "";
            int close = text.IndexOf('"', open + 1);
            if (close < 0) return "";
            return text.Substring(open + 1, close - open - 1);
        }
        catch { return ""; }
    }

    private string StateFilePath
    {
        get { return Path.Combine(_homeDir, "state", "installer.state"); }
    }

    private void LoadInstallState()
    {
        _alreadyInstalled = false;
        _installedVersion = "";
        _installedApp = "";
        _installedClients.Clear();
        if (File.Exists(StateFilePath))
        {
            try
            {
                foreach (string raw in File.ReadAllLines(StateFilePath, Encoding.UTF8))
                {
                    int eq = raw.IndexOf('=');
                    if (eq < 1) continue;
                    string key = raw.Substring(0, eq).Trim();
                    string val = raw.Substring(eq + 1).Trim();
                    if (key == "version") _installedVersion = val;
                    else if (key == "app") _installedApp = val;
                    else if (key == "clients")
                    {
                        foreach (string id in val.Split(','))
                        {
                            string trimmed = id.Trim();
                            if (trimmed.Length > 0) _installedClients.Add(trimmed);
                        }
                    }
                }
                _alreadyInstalled = true;
            }
            catch { }
        }
        if (!_alreadyInstalled && File.Exists(Path.Combine(_homeDir, "config.json")))
        {
            _alreadyInstalled = true;
        }
        if (_alreadyInstalled && _installedClients.Count == 0)
        {
            string clientsDir = Path.Combine(_homeDir, "state", "clients");
            if (Directory.Exists(clientsDir))
            {
                foreach (string dir in Directory.GetDirectories(clientsDir))
                {
                    _installedClients.Add(Path.GetFileName(dir));
                }
            }
        }
        foreach (string id in _installedClients) _clientStatus[id] = "configured";
    }

    private void SaveInstallState(List<string> clients)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StateFilePath));
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("version=" + InstallerVersion);
            sb.AppendLine("app=" + _projectDir);
            sb.AppendLine("at=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            sb.AppendLine("clients=" + string.Join(",", clients.ToArray()));
            File.WriteAllText(StateFilePath, sb.ToString(), Encoding.UTF8);
            _installedVersion = InstallerVersion;
            _installedApp = _projectDir;
            _installedClients.Clear();
            _installedClients.AddRange(clients);
            _alreadyInstalled = true;
        }
        catch { }
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
            dialog.Description = "选择已解压的 hypercontext-mode 源码目录（包含 bin\\hctx.mjs）";
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
            SetDot(_dotProject, "#3FB47F");
        }
        else
        {
            _txtProject.Text = "未找到项目，请浏览或点击“下载项目”";
            SetDot(_dotProject, "#CF6156");
        }

        _node = FindNodeInfo(_projectDir);
        if (_node.Ok)
        {
            _txtNode.Text = _node.Version + "  ·  " + Path.GetFileName(_node.Path);
            _txtNode.ToolTip = _node.Path;
            SetDot(_dotNode, "#3FB47F");
        }
        else if (!string.IsNullOrEmpty(_node.Path))
        {
            _txtNode.Text = _node.Version + "（需要 22.18+）  ·  " + Path.GetFileName(_node.Path);
            _txtNode.ToolTip = _node.Path;
            SetDot(_dotNode, "#E6A53A");
        }
        else
        {
            _txtNode.Text = "未找到 Node.js 22.18+，可点击右侧下载";
            SetDot(_dotNode, "#CF6156");
        }

        bool engines = EnginesBuilt(_projectDir);
        if (engines)
        {
            _txtEngines.Text = "已构建 context-mode + billion-context";
            SetDot(_dotEngines, "#3FB47F");
        }
        else
        {
            _txtEngines.Text = "未构建，安装时会自动执行 npm setup/build";
            SetDot(_dotEngines, "#E6A53A");
        }

        if (_alreadyInstalled && string.IsNullOrEmpty(_installedVersion)) _installedVersion = ReadPackageVersion(_projectDir);

        bool config = File.Exists(Path.Combine(_homeDir, "config.json"));
        _txtConfig.Text = config ? "已初始化" : "尚未初始化";
        _txtConfig.ToolTip = _homeDir;
        SetDot(_dotConfig, config ? "#3FB47F" : "#AEB3BA");

        List<string> missing = new List<string>();
        if (string.IsNullOrEmpty(_projectDir)) missing.Add("项目源码");
        if (!_node.Ok) missing.Add("Node.js 22.18+");
        if (!engines) missing.Add("引擎构建");
        if (!config) missing.Add("统一配置");
        bool hasProject = !string.IsNullOrEmpty(_projectDir);
        _btnDownloadProject.Visibility = hasProject ? Visibility.Collapsed : Visibility.Visible;
        _btnBrowse.Visibility = hasProject ? Visibility.Collapsed : Visibility.Visible;
        _btnDownloadNode.Visibility = _node.Ok ? Visibility.Collapsed : Visibility.Visible;
        _btnSetupEnv.Visibility = missing.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        _btnSetupEnv.IsEnabled = !_busy && hasProject && _node.Ok;
        if (_txtEnvHint != null)
        {
            _txtEnvHint.Text = missing.Count == 0
                ? "检查完成 · 4/4 项正常 · " + DateTime.Now.ToString("HH:mm:ss") + "，环境无需修复。"
                : "检查完成 · 还差：" + string.Join("、", missing.ToArray()) + " · " + DateTime.Now.ToString("HH:mm:ss");
        }
        _btnInstall.IsEnabled = !_busy && !string.IsNullOrEmpty(_projectDir) && _node.Ok;
        RefreshClientBadges();
        RefreshInstallStateUi();

        if (!_busy)
        {
            bool ready = !string.IsNullOrEmpty(_projectDir) && _node.Ok;
            if (_installSucceeded)
            {
                SetStatus("完成", "#E7F5ED", "#287653");
                _sidebarStatus.Text = "安装完成";
            }
            else if (_alreadyInstalled)
            {
                SetStatus("已安装", "#E7F5ED", "#287653");
                _sidebarStatus.Text = "已安装";
            }
            else
            {
                SetStatus(ready ? "就绪" : "需要处理", ready ? "#E7F5ED" : "#FFF1D8", ready ? "#287653" : "#93651E");
                _sidebarStatus.Text = ready ? "环境就绪" : "请先补全环境";
            }
        }
    }

    private async Task UninstallAsync()
    {
        if (_busy) return;
        if (string.IsNullOrEmpty(_projectDir) || !_node.Ok)
        {
            MessageBox.Show("需要项目源码和 Node.js 才能执行卸载。", "HyperContext 卸载", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        _cancelled = false;
        ShowStep(3);
        _logBox.Clear();
        _logCard.Visibility = Visibility.Visible;
        if (_planCard != null) _planCard.Visibility = Visibility.Collapsed;
        if (_installedCard != null) _installedCard.Visibility = Visibility.Collapsed;
        _doneCard.Visibility = Visibility.Collapsed;
        SetBusy(true);
        SetStatus("卸载计划", "#ECEEF1", "#68707A");

        try
        {
            await RunHctxAsync("uninstall", "生成卸载计划");
            MessageBoxResult answer = MessageBox.Show(
                "确认按日志里的计划卸载？\n\n· 停止本地压缩代理\n· 还原被改过的客户端配置（改前再备份一次）\n· 删除 ~/.hypercontext（会话记忆与索引，不可恢复）\n\n不想丢数据的话先取消，改用命令行 hctx uninstall --keep-data。",
                "HyperContext 卸载", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (answer != MessageBoxResult.Yes)
            {
                Log("已取消卸载。");
                SetStatus("已安装", "#E7F5ED", "#287653");
                _sidebarStatus.Text = "已安装";
                return;
            }

            SetStatus("卸载中", "#FFF1D8", "#93651E");
            await RunHctxAsync("uninstall --yes", "执行卸载");
            _alreadyInstalled = false;
            _installSucceeded = false;
            _installedVersion = "";
            _installedClients.Clear();
            _clientStatus.Clear();
            _detectedCache.Clear();
            _txtDone.Text = "已卸载：客户端配置已还原，统一目录已删除。源码目录可以自行删除。";
            _doneCard.Visibility = Visibility.Visible;
            _btnOpenHome.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException)
        {
            Log("卸载已停止。");
            SetStatus("已停止", "#FFF1D8", "#93651E");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("卸载出错", "#FFEBE8", "#A83F34");
        }
        finally
        {
            SetBusy(false);
            CheckEnvironment();
            if (_doneCard.Visibility == Visibility.Visible)
            {
                SetStatus("已卸载", "#E9ECEF", "#666E77");
                _sidebarStatus.Text = "已卸载";
            }
            RefreshInstallStateUi();
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
        if (_btnRedo != null) _btnRedo.IsEnabled = !busy;
        if (_btnUninstall != null) _btnUninstall.IsEnabled = !busy;
        _btnDownloadNode.IsEnabled = !busy;
        _btnDownloadProject.IsEnabled = !busy;
        _btnStepEnv.IsEnabled = !busy;
        _btnStepClients.IsEnabled = !busy;
        _btnStepInstall.IsEnabled = !busy;
        _btnBack.IsEnabled = !busy;
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

    private void CollectSelected(Panel panel, List<string> result)
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
        if (_planCard != null) _planCard.Visibility = Visibility.Collapsed;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("下载 Node.js", "#ECEEF1", "#68707A");
        try
        {
            await DownloadNodeCoreAsync();
            CheckEnvironment();
            SetStatus("Node 已就绪", "#E7F5ED", "#287653");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("下载失败", "#FFEBE8", "#A83F34");
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
        if (_planCard != null) _planCard.Visibility = Visibility.Collapsed;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("下载项目", "#ECEEF1", "#68707A");
        try
        {
            await DownloadProjectCoreAsync();
            CheckEnvironment();
            SetStatus("项目已下载", "#E7F5ED", "#287653");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("下载失败", "#FFEBE8", "#A83F34");
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
        if (_planCard != null) _planCard.Visibility = Visibility.Collapsed;
        _doneCard.Visibility = Visibility.Collapsed;
        SetStatus("准备环境", "#ECEEF1", "#68707A");
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
            SetStatus("环境就绪", "#E7F5ED", "#287653");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("环境安装失败", "#FFEBE8", "#A83F34");
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
        _clientStatus.Clear();
        _detectedCache.Clear();
        _installSucceeded = false;
        _alreadyInstalled = false;
        ShowStep(3);
        _logBox.Clear();
        _logCard.Visibility = Visibility.Visible;
        if (_planCard != null) _planCard.Visibility = Visibility.Collapsed;
        _doneCard.Visibility = Visibility.Collapsed;
        _btnOpenHome.Visibility = Visibility.Collapsed;
        SetBusy(true);
        SetStatus("安装中", "#ECEEF1", "#68707A");
        RefreshClientBadges();

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
            _installSucceeded = true;
            SaveInstallState(selected);
            RefreshInstallStateUi();
            _doneCard.Visibility = Visibility.Visible;
            _btnOpenHome.Visibility = Visibility.Visible;
            _txtDone.Text = BuildDoneText(selected);
            SetStatus("完成", "#E7F5ED", "#287653");
            _sidebarStatus.Text = "安装完成";
        }
        catch (OperationCanceledException)
        {
            Log("安装已停止。");
            SetStatus("已停止", "#FFF1D8", "#93651E");
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.Message);
            SetStatus("安装出错", "#FFEBE8", "#A83F34");
        }
        finally
        {
            SetBusy(false);
            CheckEnvironment();
            if (_doneCard.Visibility == Visibility.Visible)
            {
                SetStatus("完成", "#E7F5ED", "#287653");
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
        bool installed = IsClientInstalledCached(id);
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
            _clientStatus[id] = "failed";
            Log("配置 " + label + " 返回 " + code + "，继续下一个。");
        }
        else
        {
            _clientStatus[id] = installed ? "configured" : "artifacts";
        }
        RefreshClientBadges();

        if (id == "codex" && installed && code == 0)
        {
            EnsureCodexMcp();
        }
    }

    private bool IsClientInstalledCached(string id)
    {
        bool value;
        if (_detectedCache.TryGetValue(id, out value)) return value;
        value = IsClientInstalled(id);
        _detectedCache[id] = value;
        return value;
    }

    private void RefreshClientBadges()
    {
        foreach (KeyValuePair<string, Border> pair in _badges)
        {
            Border badge = pair.Value;
            if (badge == null) continue;
            string status;
            if (_clientStatus.TryGetValue(pair.Key, out status))
            {
                if (status == "configured") SetBadge(badge, "已配置", "#FFF1D8", "#93651E");
                else if (status == "artifacts") SetBadge(badge, "已生成", "#E9F4EE", "#3B6853");
                else SetBadge(badge, "失败", "#FFEBE8", "#A83F34");
                continue;
            }
            if (IsClientInstalledCached(pair.Key)) SetBadge(badge, "已检测", "#E7F5ED", "#287653");
            else SetBadge(badge, "未检测", "#E9ECEF", "#666E77");
        }
    }

    private void SetBadge(Border badge, string text, string background, string foreground)
    {
        badge.Background = BrushFrom(background);
        TextBlock child = badge.Child as TextBlock;
        if (child != null)
        {
            child.Text = text;
            child.Foreground = BrushFrom(foreground);
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
        if (id == "qoder-intl")
        {
            return AnyDirectoryExists(
                Path.Combine(appData, "Qoder"),
                Path.Combine(localAppData, "Qoder"),
                Path.Combine(user, ".qoder")) || WhereExists("qoder");
        }
        if (id == "qoder-cn")
        {
            return AnyDirectoryExists(
                Path.Combine(appData, "com.qodercn.app.stable"),
                Path.Combine(localAppData, "Qoder CN"),
                Path.Combine(localAppData, "qoder-cn-updater"),
                Path.Combine(user, ".qoder-cn"),
                Path.Combine(user, ".qoder-switch")) || WhereExists("qoder");
        }
        if (id == "workbuddy-intl" || id == "workbuddy-cn")
        {
            return AnyDirectoryExists(
                Path.Combine(appData, "WorkBuddy"),
                Path.Combine(localAppData, "WorkBuddy"),
                Path.Combine(user, "WorkBuddy"),
                Path.Combine(user, ".workbuddy"),
                Path.Combine(localAppData, "@genieworkbuddy-desktop-updater")) || WhereExists("workbuddy");
        }
        if (id == "dsh")
        {
            return AnyDirectoryExists(
                Path.Combine(user, ".dsh"),
                Path.Combine(appData, "@deepseek-ai"),
                Path.Combine(localAppData, "dsh-desktop-updater")) || WhereExists("dsh");
        }
        if (id == "zcode")
        {
            return AnyDirectoryExists(
                Path.Combine(user, ".zcode"),
                Path.Combine(appData, "zcode"),
                Path.Combine(localAppData, "zcode")) || WhereExists("zcode");
        }
        return false;
    }

    private static bool AnyDirectoryExists(params string[] paths)
    {
        foreach (string path in paths)
        {
            if (Directory.Exists(path)) return true;
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
            int initialStep = 1;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--step") int.TryParse(args[i + 1], out initialStep);
            }
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            SetupApp setup = new SetupApp();
            setup.InitialStep = initialStep;
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
