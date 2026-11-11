// Node 22 原生 TS 测试的最小加载器：只补项目现有的无扩展名相对导入，
// 并把 Electron 换成空壳；业务服务与其真实实现仍由原模块加载。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: 'dox-test:electron', shortCircuit: true }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw err
  }
}

export async function load(url, context, nextLoad) {
  if (url === 'dox-test:electron') {
    return {
      format: 'module',
      source: 'export const app = { isPackaged: false };',
      shortCircuit: true
    }
  }
  return nextLoad(url, context)
}
