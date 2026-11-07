// 发布构建时，Windows 上不要弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    steward_lib::run();
}
