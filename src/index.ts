import { promises } from 'fs'
import path from 'path'
import { compile } from 'svelte/compiler'
import { optimize, type Config } from 'svgo'
import type { Plugin } from 'vite'

const { readFile } = promises

interface Options {
  /**
   * Output type
   *
   * `dataurl` can also take the following options, which are verbatim SVGO
   * `datauri` options:
   *
   * - `?dataurl=base64` (default, same as `?dataurl`)
   * - `?dataurl=enc` URL encoded string
   * - `?dataurl=unenc` Plain SVG
   *
   * @default "component"
   */
  type?: 'src' | 'url' | 'component' | 'dataurl'
  /**
   * Verbatim [SVGO](https://github.com/svg/svgo) options
   *
   * If no options are given, the SVG will be optimized with the default SVGO
   * options.
   * If `false` SVGO will be bypassed altogether
   */
  svgoOptions?: Config | false
  /**
   * Paths to apply the SVG plugin on. This can be useful if you want to apply
   * different SVGO options/plugins on different SVGs.
   *
   * The paths are path prefixes and should be relative to your
   * `svelte.config.js` file.
   *
   * @example
   * ```
   * {
   *   includePaths: ['src/assets/icons/', 'src/images/icons/']
   * }
   * ```
   */
  includePaths?: string[]
  /**
   * Hook that lets you transform the svg to a raw Svelte component yourself,
   * before being passed to the Svelte compiler.
   *
   * @param rawSvg The raw SVG data as read from disk
   * @param splitSvg The SVG split into parts, e.g its attributes and
   *  its content
   * @returns This should return a complete Svelte component that can be passed
   *  to the Svelte compiler
   */
  preCompileHook?(rawSvg: string, splitSvg: SplitSvg): string
}

type Position = {
  line: number
  column: number
  character: number
}

type CompileError = Error & {
  code: string
  pos: number
  filename: string
  frame: string
  start: Position
  end: Position
}

type SplitSvg = {
  /**
   * The attributes of an SVG as a string
   *
   * Given `<svg width="200" height="100">` this will be
   * `width="200" height="100"`
   */
  attributes: string | undefined
  /**
   * The inner content of an SVG
   *
   * Given `<svg><g><path/></g></svg>` this will be `<g><path/></g>`.
   */
  content: string | undefined
  /**
   * The default generated, by this plugin, Svelte component as a string
   *
   * Given `<svg width="100"><path/></svg>` this will be something like
   * `<svg width="100" {...$$props}>{@html "<path/>"}</svg>`
   */
  component: string
}

function isCompileError(err: unknown): err is CompileError {
  return err instanceof Error && 'code' in err && 'frame' in err
}

const svgRegex = /<svg(.*?)>(.*)<\/svg>/s

function color(start: string, end = '\u001b[0m'): (text: string) => string {
  return (text: string) => `${start}${text}${end}`
}

const yellow = color('\u001b[33m')
const blue = color('\u001b[34m')

function toComponent(svg: string): SplitSvg {
  const parts = svgRegex.exec(svg)

  if (!parts) {
    throw new Error('Invalid SVG')
  }

  const [, attributes, content] = parts
  // JSON.stringify escapes any characters that need to be escaped and
  // surrounds `content` with double quotes
  const contentStrLiteral = JSON.stringify(content)
  const component = `<svg ${attributes} {...$$props}>{@html ${contentStrLiteral}}</svg>`

  return {
    attributes,
    content,
    component,
  }
}

function isSvgoOptimizeError(obj: unknown): obj is Error {
  return typeof obj === 'object' && obj !== null && !('data' in obj)
}

function hasCdata(code: string): boolean {
  return code.includes('<![CDATA[')
}

function readSvg(options: Options = { type: 'component' }): Plugin {
  const resvg = /\.svg(?:\?(src|url|component|dataurl)(=(base64|(un)?enc))?)?$/

  if (options.includePaths) {
    // Normalize the include paths prefixes ahead of time
    options.includePaths = options.includePaths.map((pattern) => {
      const filepath = path.resolve(path.normalize(pattern))
      return path.sep === '\\' ? filepath.replace(/\\/g, '/') : filepath
    })
  }

  const isType = (str: string | undefined, type: Options['type']): boolean => {
    return (!str && options.type === type) || str === type
  }

  const hook = options.preCompileHook

  return {
    name: 'sveltekit-svg',
    async transform(
      source: string,
      id: string,
      transformOptions?: { ssr?: boolean }
    ) {
      if (options.includePaths) {
        const isIncluded = options.includePaths.some((pattern) => {
          return id.startsWith(pattern)
        })

        if (!isIncluded) {
          return undefined
        }
      }

      const match = id.match(resvg)

      if (!match) {
        return undefined
      }

      const isBuild = transformOptions?.ssr ?? false
      const type = match[1]

      if (isType(type, 'url')) {
        return source
      }

      let svgo = options.svgoOptions
      let isSvgoDataUri = false

      if (svgo && typeof svgo === 'object') {
        if (svgo.datauri) {
          isSvgoDataUri = true
        }
      }

      if (isSvgoDataUri && type === 'component') {
        console.warn(
          `%s Type %O can not be imported as a Svelte component ` +
            `since "datauri" is set in vite.config`,
          yellow('[WARNING]'),
          id
        )
      } else if (type === 'dataurl') {
        const t = match[3] ?? 'base64'

        if (!svgo) {
          svgo = {}
        }

        svgo.datauri = t as Config['datauri']
        isSvgoDataUri = true
      }

      try {
        const filename = id.replace(/\.svg(\?.*)$/, '.svg')
        const data = (await readFile(filename)).toString('utf-8')
        const opt =
          svgo !== false
            ? optimize(data, { path: filename, ...svgo })
            : { data }

        if (isSvgoOptimizeError(opt)) {
          console.error('Got optimize error from SVGO:', opt)
          return undefined
        }

        if (isType(type, 'src') || isSvgoDataUri) {
          return `\nexport default \`${opt.data}\`;`
        }

        const comp = toComponent(opt.data)
        opt.data = hook ? hook(opt.data, comp) : comp.component
        const { js } = compile(opt.data, {
          css: 'none',
          filename: id,
          hydratable: !isBuild,
          namespace: 'svg',
          generate: isBuild ? 'ssr' : 'dom',
        })

        return js
      } catch (err: unknown) {
        if (isCompileError(err) && hasCdata(err.frame)) {
          const msg =
            `\n%s The SVG file %O contains a %s section which is not ` +
            `supported by Svelte. To make this SVG work with the %s ` +
            `plugin, you need to remove all %s sections from the SVG.\n`

          console.warn(
            msg,
            yellow('[WARNING]'),
            id,
            blue('<![CDATA[...]]>'),
            blue('@poppanator/sveltekit-svg'),
            blue('<![CDATA[...]]>')
          )
        } else {
          console.error(
            'Failed reading SVG "%s": %s',
            id,
            (err as Error).message,
            err
          )
        }

        return undefined
      }
    },
  }
}

export = readSvg
