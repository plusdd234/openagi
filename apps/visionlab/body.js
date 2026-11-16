/* visionlab 的窗口 DOM。app-scan 会自动排在 app.js 之前内联。 */
window.VL_BODY = '' +
'<div class="vl-wrap">' +
  '<div class="vl-bar">' +
    '<div class="vl-group">' +
      '<button type="button" class="vl-btn vl-primary" data-act="open">打开图片</button>' +
      '<input type="file" accept="image/*" data-ref="file" hidden>' +
      '<button type="button" class="vl-btn" data-act="extract">提取线稿</button>' +
      '<button type="button" class="vl-btn" data-act="only">只看重绘</button>' +
      '<button type="button" class="vl-btn" data-act="ckpt">控制点</button>' +
      '<button type="button" class="vl-btn" data-act="reset">重置</button>' +
    '</div>' +
    '<div class="vl-group">' +
      '<button type="button" class="vl-btn vl-ai" data-act="run">监督重绘</button>' +
      '<button type="button" class="vl-btn vl-danger" data-act="stop" disabled>停止</button>' +
    '</div>' +
    '<span class="vl-spacer"></span>' +
    '<span class="vl-status"><i class="vl-dot" data-ref="dot"></i><span class="vl-stat" data-ref="stat">未载入图像</span></span>' +
    '<button type="button" class="vl-btn vl-ghost" data-act="export">导出记录</button>' +
  '</div>' +
  '<div class="vl-main">' +
    '<div class="vl-stage" data-ref="stage">' +
      '<canvas class="vl-canvas" data-ref="canvas"></canvas>' +
      '<div class="vl-empty" data-ref="empty">' +
        '<div class="vl-empty-t">拖入图片 / 粘贴截图 / 点「打开图片」</div>' +
        '<div class="vl-empty-s">载入后拖出一个框选区，再点「提取线稿」。不框选就按整图处理。</div>' +
      '</div>' +
      '<div class="vl-hud">拖拽框选 · 不选则整图</div>' +
      '<div class="vl-legend" data-ref="legend"></div>' +
      '<div class="vl-param">' +
        '<span class="vl-param-t">提取</span>' +
        '<label>形态 ' +
          '<select data-ref="shape">' +
            '<option value="auto">自动</option>' +
            '<option value="contour">轮廓</option>' +
            '<option value="center">中线</option>' +
          '</select>' +
        '</label>' +
        '<label>取线 ' +
          '<select data-ref="src">' +
            '<option value="auto">自动</option>' +
            '<option value="edge">边缘</option>' +
            '<option value="dark">暗线</option>' +
            '<option value="color">色块</option>' +
          '</select>' +
        '</label>' +
        '<label>阈值 <input type="range" min="5" max="60" step="1" value="20" data-ref="threshold"><b data-ref="thresholdV">20</b></label>' +
        '<label>简化 <input type="range" min="0" max="3" step="0.1" value="0.5" data-ref="simplify"><b data-ref="simplifyV">0.5</b></label>' +
        '<label>最短段 <input type="range" min="0" max="60" step="1" value="8" data-ref="minLen"><b data-ref="minLenV">8</b></label>' +
        '<label class="vl-fill">填色 <input type="checkbox" data-ref="fill" checked></label>' +
      '</div>' +
    '</div>' +
    '<div class="vl-side">' +
      '<div class="vl-tabs">' +
        '<button type="button" class="vl-tab is-on" data-tab="parts">线稿<b data-ref="partsN">0</b></button>' +
        '<button type="button" class="vl-tab" data-tab="sup">监督</button>' +
        '<button type="button" class="vl-tab" data-tab="lab">实验</button>' +
      '</div>' +
      '<div class="vl-pane" data-pane="parts">' +
        '<div class="vl-layers" data-ref="layers" hidden></div>' +
        '<div class="vl-parts" data-ref="partsList"><div class="vl-none">还没有线段。先载入图片并提取线稿。</div></div>' +
      '</div>' +
      '<div class="vl-pane" data-pane="sup" hidden>' +
        '<div class="vl-sup-head">' +
          '<span class="vl-phase" data-ref="phase">待命</span>' +
          '<span class="vl-round" data-ref="round"></span>' +
        '</div>' +
        '<div class="vl-metrics" data-ref="metrics" hidden></div>' +
        '<div class="vl-sup" data-ref="sup"></div>' +
      '</div>' +
      '<div class="vl-pane" data-pane="lab" hidden>' +
        '<div class="vl-lab-h">改良方案</div>' +
        '<div class="vl-variants" data-ref="variants"></div>' +
        '<div class="vl-lab-h">运行记录</div>' +
        '<div class="vl-runs" data-ref="runs"><div class="vl-none">还没有记录。</div></div>' +
      '</div>' +
    '</div>' +
  '</div>' +
'</div>';
