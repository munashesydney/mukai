# Persistent, app-owned native desktop helper. Inputs arrive as JSON, never executable code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public static class MukaiDesktop {
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
    public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
    public ushort vk,scan; public uint flags,time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] struct UNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT key;
  }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION value; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder data,int length,out int needed);
  static HashSet<string> held = new HashSet<string>();
  static HashSet<string> buttons = new HashSet<string>();
  static Dictionary<string,ushort> names = new Dictionary<string,ushort> {
    {"CTRL",0x11},{"ALT",0x12},{"SHIFT",0x10},{"SUPER",0x5B},{"ENTER",0x0D},
    {"ESCAPE",0x1B},{"TAB",0x09},{"BACKSPACE",0x08},{"DELETE",0x2E},{"SPACE",0x20},
    {"UP",0x26},{"DOWN",0x28},{"LEFT",0x25},{"RIGHT",0x27},{"HOME",0x24},{"END",0x23},
    {"PAGEUP",0x21},{"PAGEDOWN",0x22},{"INSERT",0x2D},{"CAPSLOCK",0x14}
  };
  public static void Initialize() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
  public static bool Ready() {
    IntPtr handle = OpenInputDesktop(0,false,1);
    if(handle == IntPtr.Zero) return false;
    try { var name = new StringBuilder(256); int needed;
      return GetUserObjectInformation(handle,2,name,512,out needed) && name.ToString() == "Default";
    } finally { CloseDesktop(handle); }
  }
  static void Check() { if(!Ready()) throw new Exception("An unlocked interactive Windows desktop is required. Secure/UAC desktops cannot be controlled."); }
  static void Send(INPUT input) {
    Check();
    if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new Exception("Windows rejected desktop input. Elevated windows may require running Mukai at the same integrity level.");
  }
  public static object[] Displays() {
    Check(); var output = new List<object>();
    foreach(var screen in Screen.AllScreens) {
      var b = screen.Bounds;
      output.Add(new { id=screen.DeviceName,name=screen.DeviceName,x=b.X,y=b.Y,width=b.Width,height=b.Height,pixelWidth=b.Width,pixelHeight=b.Height,primary=screen.Primary });
    }
    return output.ToArray();
  }
  public static object Cursor() { Check(); POINT p; if(!GetCursorPos(out p)) throw new Exception("Cursor unavailable."); return new {x=p.x,y=p.y}; }
  public static void Move(double x,double y) { Check(); if(!SetCursorPos((int)Math.Round(x),(int)Math.Round(y))) throw new Exception("Pointer move failed."); }
  public static string Screenshot(string id) {
    Check(); Screen selected=null;
    foreach(var screen in Screen.AllScreens) if(screen.DeviceName==id) selected=screen;
    if(selected==null) throw new Exception("Display not found.");
    var b=selected.Bounds;
    if((long)b.Width*b.Height > 40000000) throw new Exception("Display exceeds 40 million pixels.");
    using(var bitmap=new Bitmap(b.Width,b.Height,PixelFormat.Format32bppArgb))
    using(var graphics=Graphics.FromImage(bitmap))
    using(var stream=new MemoryStream()) {
      graphics.CopyFromScreen(b.X,b.Y,0,0,b.Size,CopyPixelOperation.SourceCopy);
      bitmap.Save(stream,ImageFormat.Png);
      return Convert.ToBase64String(stream.ToArray());
    }
  }
  public static void Key(string key,bool down) {
    ushort vk;
    if(!names.TryGetValue(key,out vk)) {
      if(key.Length==1 && char.IsLetterOrDigit(key[0])) vk=(ushort)key[0];
      else if(key.StartsWith("F")) { int number=int.Parse(key.Substring(1)); if(number<1 || number>24) throw new Exception("Unsupported function key."); vk=(ushort)(0x70+number-1); }
      else throw new Exception("Unsupported key.");
    }
    bool extended=key=="SUPER" || key=="DELETE" || key=="INSERT" || key=="HOME" || key=="END" || key=="PAGEUP" || key=="PAGEDOWN" || key=="UP" || key=="DOWN" || key=="LEFT" || key=="RIGHT";
    // Track before injection so EOF cleanup also covers partial failures.
    if(down) held.Add(key);
    Send(new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{vk=vk,flags=(down?0u:2u)|(extended?1u:0u)}}});
    if(!down) held.Remove(key);
  }
  public static void Type(string text) {
    foreach(char c in text) {
      Check();
      INPUT up = new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{scan=c,flags=6}}};
      INPUT[] pair = new INPUT[]{new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{scan=c,flags=4}}},up};
      uint sent = SendInput(2,pair,Marshal.SizeOf(typeof(INPUT)));
      if(sent != 2) {
        if(sent == 1) SendInput(1,new INPUT[]{up},Marshal.SizeOf(typeof(INPUT)));
        throw new Exception("Windows rejected Unicode text input. Check focus and application integrity level.");
      }
    }
  }
  public static void Button(string button,bool down) {
    uint flag=button=="left"?(down?2u:4u):button=="right"?(down?8u:16u):button=="middle"?(down?32u:64u):0u;
    if(flag==0) throw new Exception("Unsupported mouse button.");
    if(down) buttons.Add(button);
    Send(new INPUT{type=0,value=new UNION{mouse=new MOUSEINPUT{dwFlags=flag}}});
    if(!down) buttons.Remove(button);
  }
  public static void Scroll(int dx,int dy) {
    if(dy!=0) Send(new INPUT{type=0,value=new UNION{mouse=new MOUSEINPUT{dwFlags=0x800,mouseData=unchecked((uint)(-dy))}}});
    if(dx!=0) Send(new INPUT{type=0,value=new UNION{mouse=new MOUSEINPUT{dwFlags=0x1000,mouseData=unchecked((uint)dx)}}});
  }
  public static void Release() {
    foreach(var key in new List<string>(held)) { try { Key(key,false); } catch {} }
    foreach(var button in new List<string>(buttons)) { try { Button(button,false); } catch {} }
  }
}
'@
[MukaiDesktop]::Initialize()
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
      if ($line.Length -gt 100000) { throw 'Desktop input too large.' }
      $request = $line | ConvertFrom-Json
      $result = @{ done = $true }
      switch ($request.action) {
        'status' { $result = @{ platform = 'windows'; backend = 'win32'; available = [MukaiDesktop]::Ready(); message = 'Requires an unlocked interactive desktop. Elevated applications may reject input.' } }
        'displays' { $result = @{ displays = @([MukaiDesktop]::Displays()) } }
        'screenshot' { $result = @{ image = [MukaiDesktop]::Screenshot([string]$request.displayId) } }
        'cursor' { $result = [MukaiDesktop]::Cursor() }
        'move' { [MukaiDesktop]::Move([double]$request.x, [double]$request.y) }
        'button' { [MukaiDesktop]::Button([string]$request.button, [bool]$request.down) }
        'key' { [MukaiDesktop]::Key([string]$request.key, [bool]$request.down) }
        'type' { [MukaiDesktop]::Type([string]$request.text) }
        'scroll' { [MukaiDesktop]::Scroll([int]$request.dx, [int]$request.dy) }
        'release' { [MukaiDesktop]::Release() }
        default { throw 'Unknown desktop action.' }
      }
      [Console]::WriteLine((@{ id = $request.id; result = $result } | ConvertTo-Json -Depth 8 -Compress))
    } catch {
      [Console]::WriteLine((@{ id = $request.id; error = $_.Exception.Message } | ConvertTo-Json -Depth 3 -Compress))
    }
  }
} finally { [MukaiDesktop]::Release() }
