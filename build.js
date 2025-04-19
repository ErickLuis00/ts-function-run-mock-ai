const { build } = require('esbuild')

async function main() {
    try {
        await build({
            entryPoints: ['./src/extension.ts'],
            bundle: true,
            outfile: './out/extension.js',
            external: ['vscode'],
            format: 'cjs',
            platform: 'node',
            minify: true,
            sourcemap: true,
            treeShaking: true
        });
        console.log('Build complete!');
    } catch (err) {
        console.error('Build failed:', err);
        process.exit(1);
    }
}

main();