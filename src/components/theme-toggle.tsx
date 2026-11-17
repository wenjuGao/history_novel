"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
	window.localStorage.setItem("theme", theme);
}

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
	const [theme, setTheme] = useState<Theme>("light");

	useEffect(() => {
		setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
	}, []);

	const toDark = theme === "light";
	const label = toDark ? "深色模式" : "浅色模式";

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant={toDark ? "default" : "ghost"}
						size={collapsed ? "icon-lg" : "sm"}
						className={cn(
							"w-full justify-center",
							!collapsed && "gap-2",
							toDark && "hover:bg-primary/90",
						)}
						aria-label={`切换到${label}`}
						onClick={() => {
							const next: Theme = toDark ? "dark" : "light";
							applyTheme(next);
							setTheme(next);
						}}
					>
						{toDark ? <Moon size={15} /> : <Sun size={15} />}
						{collapsed ? <span className="sr-only">{label}</span> : <span>{label}</span>}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="right" hidden={!collapsed}>
					切换{label}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
