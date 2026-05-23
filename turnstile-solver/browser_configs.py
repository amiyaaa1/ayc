import random

class browser_config:
    @staticmethod
    def _sec_ch_ua(version):
        major = version.split(".")[0]
        return f'"Google Chrome";v="{major}", "Not.A/Brand";v="8", "Chromium";v="{major}"'

    @staticmethod
    def get_random_browser_config(browser_type):
        # 返回: 浏览器名, 版本, User-Agent, Sec-CH-UA
        versions = ["143.0.0.0", "144.0.0.0", "145.0.0.0", "146.0.0.0", "147.0.0.0"]
        ver = random.choice(versions)
        ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"
        sec_ch_ua = browser_config._sec_ch_ua(ver)
        return "chrome", ver, ua, sec_ch_ua

    @staticmethod
    def get_browser_config(name, version):
        ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36"
        sec_ch_ua = browser_config._sec_ch_ua(version)
        return ua, sec_ch_ua
