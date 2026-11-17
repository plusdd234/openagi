/* 衣柜的换装目录（window.WD_PRESETS）。
 *
 * 只收录模型作者实际预留、运行时真的存在的切换。鲸鱼娘的参数开关取自作者在
 * cdi3 里的分组与随模型附带的 exp3，不猜参数。
 *   · 一个 slot = 一个互斥组；items[0] 是默认项（「不选 / 原样」）。
 *   · item.params：绝对参数值，运行时每帧写回（等价于 exp3 的 Overwrite）。
 *   · item.hide：需要压透明度 0 的整组部件。
 *   · item.show：需要拉满到 1 的整组部件（给「默认 opacity 为 0」的第二套部件用；
 *     当前这份鲸鱼娘没有这种槽位，通道先留着）。
 *
 * 关于 Haru：官方示例的 cdi3 里写了 002 制服组，但免费 runtime 的 haru.moc3
 * 只导出了 001 连衣裙（运行时部件表里没有任何 002）。切 002 只会让人物消失，
 * 所以这里不再给 Haru 做「制服」槽位 —— 宁可不换，也不假装换。
 *
 * 参考实现：A8Chann/dsh-pet-live2d 的 20 个互斥槽位（同一只鲸鱼娘），
 * 槽位划分依据 cdi3 作者分组；这里只保留与「穿搭 / 桌上的东西」相关的槽位。
 */
window.WD_PRESETS = {
  c_0120: {
    name: '鲸鱼娘',
    note: '作者预留：桌布 / 发饰 / 眼镜 / 贴纸 / 魔爪 / 鲸鱼 / 桌面摆设 / 手机 / 手部道具',
    defaultHidden: [],
    slots: [
      {
        id: 'cloth', label: '桌布', items: [
          { id: 'white', name: '白色桌布' },
          { id: 'dark', name: '黑色桌布', params: { cc2: 1 } }
        ]
      },
      {
        id: 'hair', label: '发饰', items: [
          { id: 'band', name: '戴着发箍' },
          { id: 'off', name: '摘掉发箍', params: { ParamCheek38: 3 } },
          { id: 'tail', name: '单边马尾', params: { fx1: 1 } }
        ]
      },
      {
        id: 'glasses', label: '眼镜', items: [
          { id: 'none', name: '不戴' },
          { id: 'round', name: '圆眼镜', params: { ParamCheek70: 1 } },
          { id: 'square', name: '方眼镜', params: { ParamCheek72: 1 } },
          { id: 'oval', name: '椭圆眼镜', params: { ParamCheek10: 1 } },
          { id: 'sun', name: '墨镜', params: { ParamCheek71: 1 } }
        ]
      },
      {
        id: 'sticker', label: '贴纸', items: [
          { id: 'none', name: '无' },
          { id: 'cat', name: '猫猫贴纸', params: { ParamCheek83: 1 } },
          { id: 'bunny', name: '兔兔贴纸', params: { ParamCheek82: 1 } },
          { id: 'bow', name: '蝴蝶结贴纸', params: { ParamCheek81: 1 } }
        ]
      },
      {
        id: 'claw', label: '魔爪', items: [
          { id: 'none', name: '无' },
          { id: 'pink', name: '粉魔爪', params: { mozhua: 1 } },
          { id: 'white', name: '白魔爪', params: { mozhua: 1, mozhua2: 1 } }
        ]
      },
      {
        id: 'whale', label: '鲸鱼', items: [
          { id: 'none', name: '无' },
          { id: 'head', name: '头顶鲸', params: { jingyu: 1 } },
          { id: 'desk', name: '放桌上', params: { fangzhuoshang: 1 } }
        ]
      },
      {
        id: 'desk', label: '桌面摆设', items: [
          { id: 'none', name: '无' },
          { id: 'parfait', name: '巴菲', params: { baleite: 1 } }
        ]
      },
      {
        id: 'phone', label: '手机', items: [
          { id: 'none', name: '原色' },
          { id: 'color', name: '手机换色', params: { shouji: 1 } }
        ]
      },
      {
        id: 'rhand', label: '右手', items: [
          { id: 'none', name: '自然' },
          { id: 'paw', name: '猫爪', params: { maoshou: 1, ParamCheek51: 0, ParamCheek61: 0 } },
          { id: 'peace', name: '双手比耶', params: { phone7: 1 } }
        ]
      },
      {
        id: 'lhand', label: '左手', items: [
          { id: 'none', name: '自然' },
          { id: 'retract', name: '撤回', params: { chehui: 1 } },
          { id: 'brush', name: '画笔', params: { bi: 1 } },
          { id: 'eraser', name: '橡皮', params: { pi: 1 } },
          { id: 'omelet', name: '蛋包饭', params: { point: -1, danbaofan: 1 } }
        ]
      }
    ]
  }
};
