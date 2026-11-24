# 写一个 Uranus 插件

这份文档是给**插件作者**看的。上架规则和提交流程在 [README](README.md)。

---

## 最小的插件

一个插件就是一个文件夹，打成 zip 给用户，用户在控制台 → 插件 → 导入。

```
my-plugin/
  manifest.json    必须
  client.js        前端入口
  LICENSE          必须，OSI 开源协议
  README.md        说清楚它做什么、碰什么数据
```

`manifest.json`：

```json
{
  "id": "uranus-plugin-my-thing",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "你的 GitHub 用户名",
  "repo": "https://github.com/你/uranus-plugin-my-thing",
  "description": "一句话说清楚它做什么。",
  "uranus": ">=1.23.0",
  "entry": { "client": "client.js" },
  "permissions": []
}
```

`client.js` 导出一个默认函数，Uranus 加载时调用一次：

```js
export default function init(ctx) {
  console.log("我启动了", ctx.name);
}
```

`id` 必须和你在插件市场索引里那条的 `id` 一致，而且必须和文件夹名一致 —— 控制台靠它判断「这个你已经装了」。只能是小写字母、数字和连字符。

`entry` 还能有 `css`（一个样式表，会被注入到控制台里）。两个至少要有一个。

---

## 插件配置

**这是作者让用户填东西的地方。** 比如一个 TTS 插件要用户填自己的接口地址和密钥，一个天气插件要用户选城市 —— 这些值每个用户都不一样，不能写死在代码里。

你在 `manifest.json` 里声明**要哪些项**，Uranus 自动把它渲染成表单。你不用写任何界面代码，也不用操心存在哪。

```json
{
  "id": "uranus-plugin-tts-openai",
  "entry": { "client": "client.js" },
  "config": [
    {
      "key": "baseUrl",
      "type": "string",
      "title": "接口地址",
      "desc": "你那家服务商的 OpenAI 兼容地址，不用带末尾斜杠",
      "default": "https://api.openai.com/v1"
    },
    {
      "key": "apiKey",
      "type": "secret",
      "title": "密钥",
      "required": true
    },
    {
      "key": "voice",
      "type": "select",
      "title": "音色",
      "default": "alloy",
      "options": [
        { "value": "alloy", "label": "Alloy（中性）" },
        { "value": "nova", "label": "Nova（偏女声）" },
        { "value": "echo", "label": "Echo（偏男声）" }
      ]
    },
    {
      "key": "speed",
      "type": "number",
      "title": "语速",
      "default": 1,
      "min": 0.25,
      "max": 4
    },
    {
      "key": "autoPlay",
      "type": "boolean",
      "title": "收到消息自动播",
      "default": false
    }
  ]
}
```

用户在控制台里看到的就是「接口地址」「密钥」「音色」「语速」「收到消息自动播」五个控件，密钥那个是密码框，音色那个是下拉。

代码里这样读：

```js
export default function init({ config }) {
  const { baseUrl, apiKey, voice, speed, autoPlay } = config ?? {};
  if (!apiKey) return;              // 用户还没填，什么都别做
  // …拿 apiKey 去调 baseUrl
}
```

### 五种类型

| `type` | 界面 | 额外字段 |
|---|---|---|
| `string` | 单行文本框 | `maxLength`（默认 2000，只能往小调） |
| `secret` | 密码框 | 同 `string`。值不会明文显示，保存后只剩圆点 |
| `number` | 数字输入 | `min` / `max` |
| `boolean` | 开关 | — |
| `select` | 下拉 | `options`（必须，最多 50 个） |

每一项都能写：

- `key`（**必须**）：字母开头，只能有字母、数字、下划线，最长 32 字。代码里用这个名字读。
- `title`：显示的名字。不写就显示 `key`。
- `desc`：下面那行小字说明。
- `default`：默认值。`secret` 不支持默认值（一个「默认密钥」没有意义）。
- `required`：标个「必填」。**但它只是提示** —— 没填用户照样能开插件，所以你的代码必须自己处理「这一项是空的」。

`options` 可以简写成字符串数组，`["alloy", "nova"]` 等价于 value 和 label 一样。

### 做不到的事

- **不能自定义界面。** 表单由控制台渲染，你拿不到往设置页里塞 DOM 的机会。这是故意的：风格统一，而且插件不该能在设置页里画任意东西。
- **不能嵌套对象或数组。** 五种类型的平铺就是全部。真要存复杂结构，用 `string` 收一段 JSON 自己解析。
- **不能写校验逻辑。** 只有 `min`/`max`/`maxLength`/`options` 这几种声明式的限制。别的在你代码里判断。
- **配置是加载时的快照。** 用户改完要刷新页面才生效 —— 你的插件已经画了界面、挂了事件，热更新没法做干净。

### 配置存在哪

`data/plugins/<你的id>/config.json`。你**只能读不能写** —— 那是用户填的，不是你的数据。

你自己要存东西（缓存、状态）用 `data/plugins/<你的id>/storage/`。不过这一版还没有给插件读写它的 API，暂时只能用 `localStorage`。

---

## ⚠️ 关于密钥

**插件跑在浏览器里，所以 `config.apiKey` 的明文会发到浏览器。** 这躲不掉 —— 你的插件要拿它去调 API。

后果是：

- **装了你的插件的用户，他装的别的插件也能拿到这个密钥。** 插件之间同源，Uranus 拦不住。
- **配置会跟着备份包走**，包括密钥，而且不勾「含密钥」也会带。用户的备份包里有你插件的 key。

所以：

- 在 `desc` 里告诉用户这个 key 会怎么用、建议用有额度上限的那种；
- 别把你自己的 key 写进默认值（也写不了，`secret` 不支持 `default`）；
- 如果你的插件能用一个权限更小的 key 工作，就要那个。

---

## 一个插件能做什么

插件在控制台里跑，和控制台**同源**。也就是说它能：

- 改 DOM、加界面、改样式
- 用用户的会话调任何 `/api` 接口
- 读页面上的任何东西

**这也意味着用户装你的插件是在信任你。** 别辜负它：

- 不要读你用不到的数据
- 不要往外发用户的聊天记录、密钥、人设
- 在 README 里把「这个插件碰什么」写清楚，审核时会对照

`permissions` 字段现在只是**声明**，Uranus 还没按它拦什么。但审核会拿它和你的代码对照 —— 声称只改界面却在调 `/api/config`，PR 会被退回。

---

## 调试

装上之后开浏览器的开发者工具，你的 `console.log` 就在那儿。

插件报错只会在控制台里留一条警告，不会拖垮 Uranus —— 但也意味着**出错了很安静**，自己记得看。

控制台被插件写崩了的话，网址后面加 `?noplugins` 打开，这一次什么插件都不加载，开关照样点得到。

---

## 参考

[uranus-plugin-hello](https://github.com/nikonotnicotine/uranus-plugin-hello) 是一个几乎什么都不做的示例插件，五种配置类型各演示了一个。照着它的结构改最快。
