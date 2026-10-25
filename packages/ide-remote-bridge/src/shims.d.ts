// node-forge 没有自带类型，上游 services 包按隐式 any 使用（其包内未声明
// @types/node-forge）。桥的类型检查会把 services 源码连带进来，这里显式给出
// 相同的 any 语义，避免连带的类型检查在上游本就静默的位置报错。
declare module "node-forge";
