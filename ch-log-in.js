module.exports = async function (browser) {
  // This doesn't work b/c of bot detection ...
  const page = await browser.newPage();
  await page.goto('https://www.coursehero.com/login');
  const emailInput = await page.$('input[type="email"]');
  await emailInput.type(process.env.CH_USERNAME, {delay: 300});
  const passwordInput = await page.$('input[type="password"]');
  await passwordInput.type(process.env.CH_PASSWORD, {delay: 300});
  await Promise.all([
    page.$eval('#login-submit-field', el => el.click()),
    page.waitForNavigation(),
  ]);
  console.log('done');
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.close();
};
