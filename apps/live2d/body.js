/* 数字人 App 的窗口 DOM（app-scan 会把它排在 app.js 之前内联）。
 *
 * 角色是真正的 Cubism 4 皮套（鲸鱼娘 c_0120），由 pixi-live2d-display 渲染在
 * #l2dCanvas 里的 canvas 上：呼吸、眨眼、物理摆发、44 个表情、8 组动作全部由
 * moc3 自带。模型与运行时都在 apps/live2d/ 下，file:// 断网也能跑。
 */
window.L2D_BODY = `
<div class="l2d-app" id="l2dApp">
  <div class="l2d-main">

    <section class="l2d-stage" id="l2dStage">
      <div class="l2d-bg" aria-hidden="true">
        <div class="l2d-glow g1"></div>
        <div class="l2d-glow g2"></div>
        <div class="l2d-glow g3"></div>
        <div class="l2d-dots"></div>
        <div class="l2d-petal p1"></div>
        <div class="l2d-petal p2"></div>
        <div class="l2d-petal p3"></div>
        <div class="l2d-petal p4"></div>
        <div class="l2d-floor"></div>
      </div>

      <div class="l2d-hud">
        <div class="l2d-id">
          <span class="l2d-livedot" id="l2dLiveDot"></span>
          <span class="l2d-nm" id="l2dName">鲸鱼娘</span>
          <span class="l2d-mood" id="l2dMood">平静</span>
        </div>
        <div class="l2d-aff" id="l2dAff" title="亲密度">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4S3.8 15.6 3.8 9.7A4.6 4.6 0 0 1 12 6.4a4.6 4.6 0 0 1 8.2 3.3c0 5.9-8.2 10.7-8.2 10.7Z"/></svg>
          <span class="l2d-aff-bar"><i id="l2dAffFill"></i></span>
          <span class="l2d-aff-txt" id="l2dAffTxt">初识</span>
        </div>
      </div>

      <div class="l2d-rig" id="l2dRig">
        <!-- 皮套：Cubism 4 模型在 canvas 里渲染，SVG 骨架已退役 -->
        <div class="l2d-canvas" id="l2dCanvas"></div>
        <div class="l2d-rig-state" id="l2dRigLoading"><i></i><span>正在唤醒皮套…</span></div>
        <div class="l2d-rig-state is-err" id="l2dRigErr" hidden>
          <b>皮套加载失败</b>
          <span>检查 apps/live2d/model 下的 moc3 与纹理是否完整</span>
        </div>
        <div class="l2d-hit l2d-hit-head" data-part="head" title="摸摸头"></div>
        <div class="l2d-hit l2d-hit-body" data-part="body" title="戳一下"></div>
      </div>

      <div class="l2d-tip" id="l2dTip">移动鼠标，她会看着你 · 点她一下试试</div>

      <div class="l2d-say" id="l2dSay" hidden title="点一下收起">
        <div class="l2d-say-txt" id="l2dSayTxt"></div>
        <i class="l2d-say-tail" aria-hidden="true"></i>
      </div>

      <div class="l2d-acts" role="group" aria-label="动作">
        <button type="button" class="l2d-act" data-act="greet">打招呼</button>
        <button type="button" class="l2d-act" data-act="selfie">自拍</button>
        <button type="button" class="l2d-act" data-act="bubble">吹泡泡</button>
        <button type="button" class="l2d-act" data-act="ketchup">挤番茄酱</button>
        <button type="button" class="l2d-act" data-act="splash">喷水</button>
        <button type="button" class="l2d-act" data-act="openLid">开盖</button>
      </div>
    </section>

    <aside class="l2d-side">
      <div class="l2d-tabs">
        <button type="button" class="l2d-tab on" data-tab="chat">对话</button>
        <button type="button" class="l2d-tab" data-tab="persona">角色</button>
        <span class="l2d-conn" id="l2dConn" title="语言模型连接状态">检测中…</span>
      </div>

      <div class="l2d-pane l2d-pane-chat" data-pane="chat">
        <div class="l2d-log" id="l2dLog" aria-live="polite"></div>

        <div class="l2d-typing hidden" id="l2dTyping">
          <span class="l2d-typing-dots"><i></i><i></i><i></i></span>
          <span class="l2d-typing-txt">正在组织语言…</span>
        </div>

        <div class="l2d-quick" id="l2dQuick">
          <button type="button" data-quick="夸夸我今天的样子">夸夸我</button>
          <button type="button" data-quick="随便陪我聊两句吧">陪我聊聊</button>
          <button type="button" data-quick="给我讲个冷笑话">讲个笑话</button>
        </div>

        <div class="l2d-compose">
          <textarea id="l2dInput" rows="1" spellcheck="false" placeholder="和她说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="l2d-send" id="l2dSend" aria-label="发送">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12 20 4.5 15.4 20l-3.1-6.3L4.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </button>
        </div>

        <div class="l2d-foot">
          <button type="button" class="l2d-mini on" id="l2dVoice" title="语音朗读">朗读 开</button>
          <button type="button" class="l2d-mini" id="l2dClear">清空对话</button>
          <span class="l2d-count" id="l2dCount"></span>
        </div>
      </div>

      <div class="l2d-pane l2d-pane-persona hidden" data-pane="persona">
        <div class="l2d-form">
          <label class="l2d-field">
            <span class="l2d-lab">名字</span>
            <input type="text" id="l2dFName" maxlength="12" placeholder="琉音">
          </label>
          <label class="l2d-field">
            <span class="l2d-lab">怎么称呼你</span>
            <input type="text" id="l2dFUser" maxlength="12" placeholder="主人">
          </label>
          <label class="l2d-field l2d-field-grow">
            <span class="l2d-lab">人设 / 说话方式</span>
            <textarea id="l2dFPersona" rows="6" spellcheck="false"></textarea>
          </label>

          <div class="l2d-field">
            <span class="l2d-lab">朗读声音</span>
            <div class="l2d-tts">
              <select id="l2dVoiceSel" class="l2d-select" aria-label="音色"></select>
              <label class="l2d-range"><span>语速</span><input type="range" id="l2dRate" min="0.7" max="1.4" step="0.02" value="1.04"><em id="l2dRateVal">1.04</em></label>
              <label class="l2d-range"><span>音调</span><input type="range" id="l2dPitch" min="0.7" max="1.5" step="0.02" value="1.12"><em id="l2dPitchVal">1.12</em></label>
              <button type="button" class="l2d-btn" id="l2dVoiceTest">试听一句</button>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">长期记忆</span>
            <div class="l2d-mem">
              <p class="l2d-mem-txt" id="l2dMemText">还没有整理过记忆。</p>
              <div class="l2d-mem-acts">
                <button type="button" class="l2d-btn" id="l2dMemNow">整理记忆</button>
                <button type="button" class="l2d-btn" id="l2dMemClear">清空记忆</button>
                <button type="button" class="l2d-btn" id="l2dExport">导出对话</button>
              </div>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">皮套</span>
            <div class="l2d-credit">
              <b>鲸鱼娘 · c_0120</b>
              <span>形象：上善无形 / ZipZipPipe　模型：氵六青</span>
              <span>CC BY-NC-SA 4.0 · 仅非商业使用</span>
            </div>
          </div>

          <div class="l2d-field">
            <span class="l2d-lab">表情试演</span>
            <div class="l2d-exprs" id="l2dExprs">
              <button type="button" data-emo="neutral">平静</button>
              <button type="button" data-emo="happy">开心</button>
              <button type="button" data-emo="shy">害羞</button>
              <button type="button" data-emo="sad">难过</button>
              <button type="button" data-emo="angry">生气</button>
              <button type="button" data-emo="surprise">惊讶</button>
              <button type="button" data-emo="think">思考</button>
            </div>
            <div class="l2d-exprs l2d-exprs-extra" id="l2dExprsExtra">
              <button type="button" data-exp="heart-eyes">爱心眼</button>
              <button type="button" data-exp="star-eyes">星星眼</button>
              <button type="button" data-exp="tongue">吐舌</button>
              <button type="button" data-exp="sweat">流汗</button>
              <button type="button" data-exp="dizzy">晕晕</button>
              <button type="button" data-exp="sunglasses">墨镜</button>
            </div>
          </div>

          <div class="l2d-form-acts">
            <button type="button" class="l2d-btn primary" id="l2dSave">保存角色</button>
            <button type="button" class="l2d-btn" id="l2dReset">恢复默认</button>
          </div>
          <p class="l2d-note">人设与对话只存在本机；模型连接沿用工作站的统一配置（设置 → 语言模型）。</p>
        </div>
      </div>
    </aside>
  </div>
</div>
`;
