/* 邮箱台的窗口骨架。
 *
 * 这里只有**静态 DOM**，所有数据由 app.js 渲染。放在 body.js 是因为三栏界面
 * （信箱 / 收件箱 / 正文）的标签太多，塞进 app.js 会读不下去；
 * app-scan 会自动把这份文件排在 app.js 之前内联，不需要改 index.html。
 *
 * ⚠ 不是 App：这里没有 registerApp，只有 window.MAILDESK_BODY 字符串。 */
window.MAILDESK_BODY =
  '<div class="md-root">' +
    '<header class="md-head">' +
      '<div class="md-brand">' +
        '<span class="md-logo">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="5.4" width="18" height="13.2" rx="2.4"/><path d="m3.8 7.2 8.2 5.8 8.2-5.8"/></svg>' +
        '</span>' +
        '<div class="md-brand-text">' +
          '<div class="md-word">邮箱台<span class="md-tag">MAIL</span></div>' +
          '<div class="md-sub">批量申请临时信箱 · 集中收验证码与链接</div>' +
        '</div>' +
      '</div>' +
      '<div class="md-stats" aria-label="邮箱统计">' +
        '<div class="md-stat"><b id="mdStatBoxes">0</b><span>信箱</span></div>' +
        '<div class="md-stat is-accent"><b id="mdStatUnread">0</b><span>未读</span></div>' +
        '<div class="md-stat" id="mdStatIssuesWrap"><b id="mdStatIssues">0</b><span>异常</span></div>' +
      '</div>' +
      '<div class="md-head-right">' +
        '<div class="md-net" id="mdNet"><i></i><span>本地中转检测中</span></div>' +
        '<button type="button" class="md-btn md-ai-btn" id="mdAiToggle" title="打开 AI 邮箱管理助手">AI 助手</button>' +
      '</div>' +
    '</header>' +

    '<div class="md-bar">' +
      '<div class="md-group">' +
        '<label class="md-field">服务' +
          '<select id="mdProvider" title="信箱服务商">' +
            '<option value="mailtm">mail.tm</option>' +
            '<option value="guerrilla">Guerrilla</option>' +
            '<option value="mailgw">mail.gw</option>' +
            '<option value="demo">演示（离线）</option>' +
          '</select>' +
        '</label>' +
        '<label class="md-field">数量' +
          '<input type="number" id="mdCount" min="1" max="20" step="1" value="3" title="一次申请几个（1–20）">' +
        '</label>' +
        '<label class="md-field">前缀' +
          '<input type="text" id="mdPrefix" placeholder="留空随机，如 test" spellcheck="false" maxlength="12">' +
        '</label>' +
        '<button type="button" class="md-btn md-primary" id="mdCreate">批量申请</button>' +
      '</div>' +
      '<span class="md-div"></span>' +
      '<div class="md-group">' +
        '<label class="md-switch"><input type="checkbox" id="mdAuto"><span>自动收取</span></label>' +
        '<select class="md-sec" id="mdAutoSec" title="自动收取间隔">' +
          '<option value="15">15 秒</option>' +
          '<option value="30">30 秒</option>' +
          '<option value="60">60 秒</option>' +
          '<option value="120">2 分钟</option>' +
        '</select>' +
        '<button type="button" class="md-btn" id="mdSyncAll">全部刷新</button>' +
      '</div>' +
      '<div class="md-group md-group-end">' +
        '<button type="button" class="md-btn" id="mdImport" title="批量粘贴 地址----口令----client_id----refresh_token">导入</button>' +
        '<button type="button" class="md-btn" id="mdExport" title="导出 地址----口令（不含令牌）">导出</button>' +
      '</div>' +
    '</div>' +

    '<div class="md-main">' +
      '<aside class="md-side">' +
        '<div class="md-side-head">' +
          '<span class="md-side-title">信箱 <b id="mdBoxCount">0</b></span>' +
          '<span class="md-side-acts">' +
            '<button type="button" class="md-mini" id="mdAdd" title="手动登记一个已有邮箱">添加</button>' +
            '<button type="button" class="md-mini" id="mdCopyAll" title="把所有地址按行复制，方便逐个粘贴">复制地址</button>' +
          '</span>' +
        '</div>' +
        '<div class="md-filters" id="mdFilters">' +
          '<button type="button" data-filter="all" class="is-on">全部<b>0</b></button>' +
          '<button type="button" data-filter="unread">未读<b>0</b></button>' +
          '<button type="button" data-filter="pass">有口令<b>0</b></button>' +
          '<button type="button" data-filter="error">异常<b>0</b></button>' +
        '</div>' +
        '<div class="md-search-wrap">' +
          '<input type="search" id="mdSearch" placeholder="搜索地址" spellcheck="false">' +
        '</div>' +
        '<div class="md-add" id="mdAddPanel" hidden>' +
          '<input type="text" id="mdAddAddr" placeholder="name@example.com" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdAddPass" placeholder="口令（用于 IMAP 收信）" spellcheck="false" autocomplete="off">' +
          '<div class="md-add-acts">' +
            '<button type="button" class="md-mini" id="mdAddCancel">取消</button>' +
            '<button type="button" class="md-btn md-primary" id="mdAddSave">保存</button>' +
          '</div>' +
        '</div>' +
        '<div class="md-batch" id="mdBatch">' +
          '<label class="md-selall"><input type="checkbox" id="mdSelectAll"><span>全选</span></label>' +
          '<span class="md-batch-count" id="mdSelCount">未选择</span>' +
          '<span class="md-batch-acts">' +
            '<button type="button" class="md-mini" id="mdBatchRefresh" disabled>刷新</button>' +
            '<button type="button" class="md-mini" id="mdBatchCopy" disabled>复制</button>' +
            '<button type="button" class="md-mini md-danger" id="mdBatchRemove" disabled>移除</button>' +
          '</span>' +
        '</div>' +
        '<div class="md-boxes" id="mdBoxes"></div>' +
      '</aside>' +

      '<section class="md-inbox">' +
        '<div class="md-inbox-head">' +
          '<div class="md-inbox-id">' +
            '<div class="md-inbox-top">' +
              '<span class="md-inbox-addr" id="mdAddr" title="当前信箱">未选择信箱</span>' +
              '<span class="md-prov" id="mdProv" hidden></span>' +
            '</div>' +
            '<div class="md-inbox-pass" id="mdPassRow" hidden>' +
              '<span class="md-pass-k">凭证</span><b id="mdPass">—</b>' +
            '</div>' +
          '</div>' +
          '<div class="md-inbox-acts">' +
            '<button type="button" class="md-mini" id="mdCompose" disabled>写邮件</button>' +
            '<button type="button" class="md-mini" id="mdCred" disabled>凭证</button>' +
            '<button type="button" class="md-mini" id="mdCopyAddr" disabled>复制地址</button>' +
            '<button type="button" class="md-mini" id="mdCopyPass" disabled>复制口令</button>' +
            '<button type="button" class="md-mini" id="mdSyncOne" disabled>刷新</button>' +
            '<button type="button" class="md-mini md-danger" id="mdRemove" disabled>移除</button>' +
          '</div>' +
        '</div>' +
        '<div class="md-list-bar">' +
          '<span class="md-list-count" id="mdMsgCount">0 封</span>' +
          '<input type="search" id="mdMsgSearch" placeholder="搜索本信箱邮件" spellcheck="false" disabled>' +
        '</div>' +
        '<div class="md-msgs" id="mdMsgs"></div>' +
      '</section>' +

      '<article class="md-read" id="mdRead"></article>' +
    '</div>' +

    '<div class="md-ai" id="mdAi" hidden>' +
      '<div class="md-ai-head">' +
        '<span class="md-ai-title">AI 邮箱助手</span>' +
        '<span class="md-ai-note" id="mdAiNote">可汇总未读、检查凭证、刷新收信、代写信件</span>' +
        '<span class="md-ai-head-acts">' +
          '<button type="button" class="md-mini" id="mdAiClear">清空</button>' +
          '<button type="button" class="md-mini" id="mdAiClose">收起</button>' +
        '</span>' +
      '</div>' +
      '<div class="md-ai-log" id="mdAiLog"></div>' +
      '<div class="md-ai-quick">' +
        '<button type="button" class="md-mini" data-ai-q="汇总每个信箱的未读来信和验证码">汇总未读</button>' +
        '<button type="button" class="md-mini" data-ai-q="检查哪些信箱没有口令、没有 OAuth2 凭证或者收取失败">检查凭证</button>' +
        '<button type="button" class="md-mini" data-ai-q="检查哪些信箱没有口令或者收取失败">检查异常</button>' +
        '<button type="button" class="md-mini" data-ai-q="列出没有来信且没有口令的空信箱，准备清理">找出空信箱</button>' +
        '<button type="button" class="md-mini" data-ai-q="按服务商统计一下现在的信箱数量和未读情况">服务商统计</button>' +
      '</div>' +
      '<div class="md-ai-input">' +
        '<textarea id="mdAiText" rows="2" spellcheck="false" ' +
          'placeholder="例：把没有口令的空信箱删掉；或者：我现在有哪些未读？"></textarea>' +
        '<button type="button" class="md-btn md-primary" id="mdAiSend">发送</button>' +
      '</div>' +
    '</div>' +

    '<div class="md-status">' +
      '<span id="mdStatus">就绪</span>' +
      '<span class="md-hint" id="mdHint">口令与 OAuth2 令牌只存本机，收发信经本地中转</span>' +
    '</div>' +

    '<div class="md-modal" id="mdImportModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="批量导入信箱">' +
        '<div class="md-modal-head">' +
          '<b>批量导入信箱</b>' +
          '<span>每行一个：地址----口令----client_id----refresh_token</span>' +
        '</div>' +
        '<textarea id="mdImportText" spellcheck="false" ' +
          'placeholder="name@outlook.com----password----client-id----refresh-token&#10;other@example.com----password"></textarea>' +
        '<div class="md-modal-note">前两段是地址与口令，可选第三、四段为 OAuth2 的 client_id 与 refresh_token（Outlook 密码登录已关闭时必须用后者）；第 5 段起忽略。凭证只存本机，不随导出外泄。</div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini" id="mdImportCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdImportSave">导入</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="md-modal" id="mdComposeModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="写邮件">' +
        '<div class="md-modal-head">' +
          '<b>写邮件</b>' +
          '<span id="mdComposeFrom">未选择发件信箱</span>' +
        '</div>' +
        '<div class="md-form">' +
          '<input type="email" id="mdComposeTo" placeholder="收件人 name@example.com" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdComposeSubject" placeholder="主题" spellcheck="false" maxlength="200">' +
          '<textarea id="mdComposeBody" spellcheck="false" placeholder="正文（纯文本，最多 20KB）"></textarea>' +
        '</div>' +
        '<div class="md-modal-note">有口令或 OAuth2 凭证的手动邮箱可发信；邮件只经本机中转发送，不保存副本。</div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini" id="mdComposeCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdComposeSend">发送</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="md-modal" id="mdCredModal" hidden>' +
      '<div class="md-modal-card" role="dialog" aria-modal="true" aria-label="更新凭证">' +
        '<div class="md-modal-head">' +
          '<b>更新凭证</b>' +
          '<span id="mdCredAddr">—</span>' +
        '</div>' +
        '<div class="md-form">' +
          '<input type="text" id="mdCredPass" placeholder="新口令（留空不修改）" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdCredClient" placeholder="OAuth2 client_id（可选）" spellcheck="false" autocomplete="off">' +
          '<input type="text" id="mdCredToken" placeholder="OAuth2 refresh_token（可选）" spellcheck="false" autocomplete="off">' +
        '</div>' +
        '<div class="md-modal-note">留空表示不修改；OAuth2 两项需要同时填写。旧值不会回显，保存后立即用于 IMAP / SMTP。</div>' +
        '<div class="md-modal-acts">' +
          '<button type="button" class="md-mini md-danger" id="mdCredClear">清除凭证</button>' +
          '<span class="md-act-spacer"></span>' +
          '<button type="button" class="md-mini" id="mdCredCancel">取消</button>' +
          '<button type="button" class="md-btn md-primary" id="mdCredSave">保存</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
