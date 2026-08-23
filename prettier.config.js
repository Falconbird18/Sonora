/** @type { import("prettier").Config } */
const config = {
    useTabs: true,
    singleQuote: true,
    trailingComma: 'none',
    bracketSameLine: true,
    plugins: [
        'prettier-plugin-svelte'
    ],
    overrides: [
        {
            files: '*.svelte',
            options: { parser: 'svelte' }
        }
    ]
};
export default config;
