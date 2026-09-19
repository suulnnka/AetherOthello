const std = @import("std");

/// AetherOthello 的 Zig 通道。
///   原生:selftest(规则+折叠+求值基准)、train(自对弈训练,产出 weights.bin)
///   wasm:engine(浏览器 worker 里加载,只导出 C ABI 函数)
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // 不用 standardOptimizeOption:它的 preferred_optimize_mode 只有显式传
    // -Drelease 时才生效,默认仍落回 Debug —— 基准脚本跑在 Debug 上数字全废。
    // 原生工具一律 ReleaseFast,写死更省心。

    // ── 原生自测 + 基准 ────────────────────────────────────────────
    const selftest = b.addExecutable(.{
        .name = "selftest",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/selftest.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    // 注意:必须让自定义 step 也依赖 install,否则 `zig build selftest` 只编译+运行、
    // 不刷新 zig-out/bin —— 之后手工调 zig-out 里的旧二进制会看到"改了没生效"(踩过)。
    const inst_selftest = b.addInstallArtifact(selftest, .{});
    b.getInstallStep().dependOn(&inst_selftest.step);
    const run_selftest = b.addRunArtifact(selftest);
    if (b.args) |args| run_selftest.addArgs(args);
    // Step.dependOn 返回 void,不能链式调用两遍
    const st_selftest = b.step("selftest", "跑规则/折叠/求值自测与基准");
    st_selftest.dependOn(&inst_selftest.step);
    st_selftest.dependOn(&run_selftest.step);

    // ── 自对弈训练器(原生,不参与 wasm)───────────────────────────
    const train = b.addExecutable(.{
        .name = "train",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/train.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const inst_train = b.addInstallArtifact(train, .{});
    b.getInstallStep().dependOn(&inst_train.step);
    const run_train = b.addRunArtifact(train);
    if (b.args) |args| run_train.addArgs(args);
    const st_train = b.step("train", "自对弈训练并落盘 weights.bin");
    st_train.dependOn(&inst_train.step);
    st_train.dependOn(&run_train.step);

    // ── 开局书生成器(原生,⑩):宗师自对弈 → src/zig/book.bin ──────
    const genbook = b.addExecutable(.{
        .name = "genbook",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/genbook.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const inst_genbook = b.addInstallArtifact(genbook, .{});
    b.getInstallStep().dependOn(&inst_genbook.step);
    const run_genbook = b.addRunArtifact(genbook);
    if (b.args) |args| run_genbook.addArgs(args);
    const st_genbook = b.step("genbook", "自对弈生成开局书 book.bin");
    st_genbook.dependOn(&inst_genbook.step);
    st_genbook.dependOn(&run_genbook.step);

    // ── wasm 引擎 ─────────────────────────────────────────────────
    // ReleaseFast 而不是 ReleaseSmall:多出来的几百字节代码换搜索速度值。
    // ⚠ `strip = true` 不是可选项:不 strip 的话 DWARF/name 这些 custom section
    //   会把产物从 ~45 KB 顶到 700+ KB(实测 648% 预算),而它们对运行毫无用处。
    //   体积闸门(35 KB gzip)在 webos 侧兜底,真超了再往回退。
    const wasm = b.addExecutable(.{
        .name = "othello",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/engine.zig"),
            .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
            .optimize = .ReleaseFast,
            .strip = true,
        }),
    });
    // freestanding wasm 没有 _start,必须显式关掉入口并打开动态导出,
    // 否则连 export 都拿不到(踩过)。
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    b.installArtifact(wasm);

    // ── 单元测试 ──────────────────────────────────────────────────
    const unit = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/rules.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const unit2 = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/pattern.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const unit3 = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/stability.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const run_unit = b.addRunArtifact(unit);
    const run_unit2 = b.addRunArtifact(unit2);
    const run_unit3 = b.addRunArtifact(unit3);
    const test_step = b.step("test", "规则与折叠的单元测试");
    test_step.dependOn(&run_unit.step);
    test_step.dependOn(&run_unit2.step);
    test_step.dependOn(&run_unit3.step);
}
