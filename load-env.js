'use strict';
/**
 * 统一加载环境变量：先 .env，再 .env.local（覆盖前者）。
 * 从仓库根目录解析路径（与从哪个子目录执行 node 无关）。
 */
const path = require('path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname);
dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.env.local'), override: true });

module.exports = { root };
