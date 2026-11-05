# Omicswayfinder

Prototype

## Website Deployment

In GitHub, open **Settings > Pages** and set **Source** to **GitHub Actions**.

Pushes to the repository's default branch build the site, publish the contents of
`dist` to the `gh-page` branch, and deploy to GitHub Pages. The workflow can also
be run manually from the **Actions** tab on the default branch. Other branches
do not deploy. No additional token or secret is required.

Website: https://a-xavier.github.io/OmicsWayFinder/