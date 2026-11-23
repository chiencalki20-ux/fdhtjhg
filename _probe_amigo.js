/**
 * 打开 FruitInvaders 链接，保持窗口；请手动点击。
 * 信号日志写在保存目录 _probe_signals.log
 */
const path = require('path');
const fs = require('fs');
const runCrawler = require('./crawler');

const URL =
  'https://demo.amigogaming.cloud/games-alt-wgl/amigo/FruitInvaders/index.html?session=EA0252CABA2D4CD797ED484591A69B0A&sign=b1742a1f8ac888ab5fa8563963898445&endpointUri=wss://sdemo.amigogaming.cloud/organic2/websocket/endpoint/2&profile=nofullscreen.xml&resetSettings=true&replayLink=https%3A%2F%2Fdemo.amigogaming.cloud%2Forganic2%2Freplay%2Flaunch%3Freplay%3Dtrue%26session%3DEA0252CABA2D4CD797ED484591A69B0A%26sign%3Db1742a1f8ac888ab5fa8563963898445&replaySize=10&historyUrl=https%3A%2F%2Fdemo.amigogaming.cloud%2Fhistorya%2Findex.html%3Fsession%3DEA0252CABA2D4CD797ED484591A69B0A%26replaySize%3D10%26historyUrl%3Dhttps%253A%252F%252Fdemo.amigogaming.cloud%252Forganic2%252Fwebsocket%252Fhistory%253Fsession%253DEA0252CABA2D4CD797ED484591A69B0A%2526sign%253Db1742a1f8ac888ab5fa8563963898445&exit=https%3A%2F%2Fdemo.amigogaming.cloud%2Forganic2%2Fwebsocket%2Fclose%3Fsession%3DEA0252CABA2D4CD797ED484591A69B0A%26sign%3Db1742a1f8ac888ab5fa8563963898445%26exit%3Dhttps%253A%252F%252Flaunch.amigogaming.com%252Fsession%252Fback%253Flink%253Dabout%253Ablank';

const SAVE = path.join(__dirname, '_probe_save');
fs.mkdirSync(SAVE, { recursive: true });

(async () => {
  console.log('PROBE: 打开窗口，请手动操作进入免费局…');
  const instance = await runCrawler(
    URL,
    SAVE,
    1,
    true,
    [],
    'amigo',
    '86',
    {
      xMin: 1,
      xMax: 100,
      yMin: 20,
      yMax: 80,
      pickmeX: 20,
      pickmeY: 35,
      interval: 800
    }
  );
  console.log('PROBE: 已就绪。信号日志:', path.join(SAVE, '_probe_signals.log'));
  console.log('PROBE: sockets 目录在 window_* 下');
  // 不退出，方便你点
  setInterval(() => {}, 60000);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
