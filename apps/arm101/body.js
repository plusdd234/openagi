/* 101 机械臂控制台的窗口 DOM。
 *
 * 单独放 body.js 是因为结构比模板 App 长；app-scan 会自动把它排在 app.js 之前内联。
 * 这里只有骨架：关节行由 app.js 按 JOINTS 生成，三维场景画在 .arm101-canvas 上。
 */
window.ARM101_BODY = `
<div class="arm101-root">
  <section class="arm101-stage" data-stage>
    <canvas class="arm101-canvas" data-canvas></canvas>

    <div class="arm101-topbar">
      <div class="arm101-brand">
        <span class="arm101-brand-mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 20.5h7"/>
            <path d="M8 20.5v-2.6"/>
            <circle cx="8.2" cy="16.2" r="1.7"/>
            <path d="m9.6 15.1 3.9-4.6"/>
            <circle cx="14.8" cy="9" r="1.7"/>
            <path d="m16.1 7.9 2.4-1.9"/>
            <path d="m18.1 6.4 2.2 2.1"/>
            <path d="m18.7 6.6-1.2 2.8"/>
          </svg>
        </span>
        <span class="arm101-brand-txt"><b>SO-101</b><i>六轴机械臂 · 数字孪生</i></span>
      </div>
      <span class="arm101-conn" data-conn><i></i><b>串口未连接</b></span>
    </div>

    <div class="arm101-readout">
      <div class="arm101-stat"><label>TIP X</label><b data-tip-x>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>TIP Y</label><b data-tip-y>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>TIP Z</label><b data-tip-z>—</b><i>mm</i></div>
      <div class="arm101-stat"><label>PACKETS</label><b data-pkts>0</b><i>帧</i></div>
    </div>

    <div class="arm101-stagefoot">
      <span class="arm101-hint">拖拽旋转 · 滚轮缩放</span>
      <button type="button" class="arm101-ghost" data-act="view">重置视角</button>
    </div>

    <div class="arm101-estop-banner" data-estop hidden>急停已触发 · 舵机力矩已切断</div>
    <div class="arm101-fallback" data-fallback hidden>当前环境无法创建 WebGL 上下文</div>
  </section>

  <aside class="arm101-panel">
    <header class="arm101-phead">
      <div>
        <h1>101 机械臂 <span>控制台</span></h1>
        <p>6 自由度 · STS3215 总线舵机 · 1 Mbps</p>
      </div>
      <button type="button" class="arm101-link" data-act="link">断开串口</button>
    </header>

    <div class="arm101-sechead">
      <span>关节指令</span>
      <span class="arm101-secmeta">ID 01–06 · 4096 ticks</span>
    </div>
    <div class="arm101-joints" data-joints></div>

    <div class="arm101-speed">
      <span>运动速度</span>
      <input type="range" min="1" max="10" step="1" value="5" data-speed aria-label="运动速度">
      <b data-speed-v>5</b>
    </div>

    <div class="arm101-actions">
      <button type="button" class="arm101-btn arm101-btn-main" data-act="send">发送信号</button>
      <button type="button" class="arm101-btn" data-act="home">回到 Home</button>
      <button type="button" class="arm101-btn" data-act="demo">演示序列</button>
      <button type="button" class="arm101-btn arm101-btn-danger" data-act="estop">急停</button>
    </div>

    <div class="arm101-sechead arm101-sechead-log">
      <span>信号监视器</span>
      <span class="arm101-secmeta">SCS · 8N1</span>
    </div>
    <div class="arm101-log" data-log aria-live="polite"></div>
  </aside>
</div>
`;
