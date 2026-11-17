"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { Toaster } from "@/components/ui/sonner";

const items: Array<{ href: string; label: string; icon: typeof Compass }> = [
	{ href: "/", label: "概览", icon: Compass },
	{ href: "/models", label: "模型与密钥", icon: Settings2 },
];

/** 全局框架：左侧平台导航（概览 / 模型与密钥），作品内导航由作品路由布局自带。 */
export function AppFrame({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const wide = useMediaQuery("(min-width: 1280px)");
	const [collapsed, setCollapsed] = useState(false);
	const iconOnly = collapsed || !wide;

	return (
		<TooltipProvider>
			<div
				className={cn(
					"grid h-dvh min-h-0 grid-cols-[var(--rail-w)_minmax(0,1fr)] overflow-hidden bg-background text-foreground",
					iconOnly ? "[--rail-w:4rem]" : "[--rail-w:13.75rem]",
				)}
			>
				<nav className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden border-r border-border bg-sidebar px-2 py-4">
					<div className={cn("flex min-w-0 items-center gap-2 px-1", iconOnly && "justify-center px-0")}>
						<span className="grid size-8 shrink-0 place-items-center rounded-sm bg-primary font-serif text-[15px] text-primary-foreground">
							史
						</span>
						{!iconOnly && (
							<span className="min-w-0 truncate whitespace-nowrap font-serif text-[15px] tracking-[0.18em] text-foreground">
								史稿
							</span>
						)}
					</div>

					<ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
						{items.map((item) => {
							const active = pathname === item.href;
							return (
								<li key={item.href}>
									<Tooltip>
										<TooltipTrigger asChild>
											<Link
												href={item.href}
												aria-current={active ? "page" : undefined}
												className={cn(
													"flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
													iconOnly && "h-11 justify-center px-0",
													active
														? "bg-primary/10 font-medium text-primary ring-1 ring-primary/25 ring-inset"
														: "text-muted-foreground hover:bg-muted hover:text-foreground",
												)}
											>
												<item.icon size={17} strokeWidth={1.8} className="shrink-0" />
												<span className={cn("truncate text-[13px]", iconOnly && "sr-only")}>{item.label}</span>
											</Link>
										</TooltipTrigger>
										<TooltipContent side="right" hidden={!iconOnly}>
											{item.label}
										</TooltipContent>
									</Tooltip>
								</li>
							);
						})}
					</ul>

					<div className="flex shrink-0 flex-col gap-1.5 border-t border-border pt-3">
						{wide && (
							<Button
								variant="ghost"
								size={iconOnly ? "icon-lg" : "sm"}
								className={cn(iconOnly ? "w-full justify-center" : "justify-start gap-2")}
								onClick={() => setCollapsed((current) => !current)}
								aria-pressed={iconOnly}
							>
								{iconOnly ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
								{iconOnly ? <span className="sr-only">展开侧栏</span> : <span>收起侧栏</span>}
							</Button>
						)}
						<ThemeToggle collapsed={iconOnly} />
					</div>
				</nav>

				<main className="min-h-0 overflow-hidden">{children}</main>
			</div>

			<Toaster position="bottom-right" richColors closeButton />
		</TooltipProvider>
	);
}
