package com.chishenme.app.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CuisineExclusionPolicyTest {
    @Test
    fun `grouped choice excludes its own and provider child category tags`() {
        for (tags in listOf(
            listOf("川湘菜"),
            listOf("川菜"),
            listOf("湘菜"),
            listOf("正餐", "四川菜(川菜)"),
            listOf("正餐", " 湖南湘菜 "),
        )) {
            assertTrue(tags.toString(), CuisineExclusionPolicy.hasExcludedCuisine(tags, listOf("川湘菜")))
        }
    }

    @Test
    fun `normalizes whitespace before expanding grouped choices`() {
        assertTrue(CuisineExclusionPolicy.hasExcludedCuisine(listOf(" 川菜 "), listOf(" 川湘菜 ")))
        assertTrue(CuisineExclusionPolicy.hasExcludedCuisine(listOf(" 湘菜 "), listOf("\t川湘菜\n")))
    }

    @Test
    fun `normalizes case and preserves one way substring matching`() {
        assertTrue(CuisineExclusionPolicy.hasExcludedCuisine(listOf(" Modern ITALIAN "), listOf(" italian ")))
        assertTrue(CuisineExclusionPolicy.hasExcludedCuisine(listOf(" 重庆火锅 "), listOf(" 火锅 ")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("火锅"), listOf("重庆火锅")))
    }

    @Test
    fun `does not infer unrelated cuisines from grouped exclusions`() {
        for (tag in listOf("面食", "中式快餐", "粤菜", "川味", "湘味", "川湘", "麻辣", "小炒")) {
            assertFalse(tag, CuisineExclusionPolicy.hasExcludedCuisine(listOf(tag), listOf("川湘菜")))
        }
    }

    @Test
    fun `does not expand a child exclusion to its sibling or parent category`() {
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("湘菜"), listOf("川菜")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("川菜"), listOf("湘菜")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("川湘菜"), listOf("川菜")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("川菜", "湘菜"), listOf("火锅")))
    }

    @Test
    fun `missing or unrecognized tags do not establish an exclusion conflict`() {
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(emptyList(), listOf("川湘菜")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("未知菜系"), listOf("川湘菜")))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf(" "), listOf("川湘菜")))
    }

    @Test
    fun `empty exclusions cannot match every tag`() {
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("川菜", "湘菜"), emptyList()))
        assertFalse(CuisineExclusionPolicy.hasExcludedCuisine(listOf("川菜"), listOf("", " \t ")))
    }

    @Test
    fun `finds any excluded category among multiple tags and exclusions`() {
        assertTrue(
            CuisineExclusionPolicy.hasExcludedCuisine(
                listOf("面食", "湘菜"),
                listOf("火锅", "川湘菜", "川湘菜"),
            ),
        )
        assertTrue(
            CuisineExclusionPolicy.hasExcludedCuisine(listOf("重庆火锅"), listOf("", "火锅")),
        )
    }
}
