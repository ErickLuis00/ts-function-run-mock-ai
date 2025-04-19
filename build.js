const { build } = require('esbuild')

const production = process.argv.includes('--production')

async function main() {
    try {
        await build({
            entryPoints: ['./src/extension.ts'],
            bundle: true,
            outfile: './out/extension.js',
            external: ['vscode'],
            format: 'cjs',
            platform: 'node',
            minify: production,
            sourcemap: !production,
            treeShaking: true,
            define: {
                'process.env.NODE_ENV': production ? '"production"' : '"development"'
            },
        })
        console.log('Build complete!')
    } catch (err) {
        console.error('Build failed:', err)
        process.exit(1)
    }
}

main() 